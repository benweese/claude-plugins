// "What will this command commit?" — shared by the guardrails and privacy plugins.
// SOURCE OF TRUTH: shared/commit-content.mjs in the plugins repo. It is copied byte-for-byte into
// plugins/guardrails/scripts/ and plugins/privacy/scripts/ by `node scripts/sync-shared.mjs`
// (plugins install separately, so they can't import each other). A test fails if a copy differs:
// edit the source, then run the sync script.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Splits a shell command line into simple commands at && || ; | and newlines (quotes respected). */
export function splitCommands(line) {
	const parts = [];
	let cur = "";
	let q = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (q) {
			cur += ch;
			if (ch === q) q = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			q = ch;
			cur += ch;
			continue;
		}
		const two = line.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			parts.push(cur);
			cur = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "\n") {
			parts.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	parts.push(cur);
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** Words of a simple command (quotes removed; good enough for flags and paths). */
export function words(cmd) {
	const out = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m;
	while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

/** For `git [-C dir] [-c k=v] <sub> …`: { sub, args } — or null if it isn't git. */
export function gitSub(cmd) {
	const w = words(cmd);
	let i = 0;
	while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++; // leading VAR=value
	if (w[i] !== "git") return null;
	i++;
	while (i < w.length && w[i].startsWith("-")) i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
	return w[i] ? { sub: w[i], args: w.slice(i + 1) } : null;
}

/** Runs git in a folder; returns stdout ("" on error). */
export function git(cwd, args) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return r.status === 0 ? r.stdout : "";
}

/** Added lines per file from a unified diff (-U0): [{file, lines: [{n, text}]}]. */
export function addedLines(diff) {
	const files = [];
	let cur = null;
	let n = 0;
	for (const l of diff.split("\n")) {
		if (l.startsWith("+++ ")) {
			const f = l.slice(4).replace(/^b\//, "");
			cur = f === "/dev/null" ? null : { file: f, lines: [] };
			if (cur) files.push(cur);
		} else if (l.startsWith("@@")) {
			const m = /\+(\d+)/.exec(l);
			n = m ? Number(m[1]) : 0;
		} else if (cur && l.startsWith("+")) {
			cur.lines.push({ n: n++, text: l.slice(1) });
		} else if (cur && !l.startsWith("-") && !l.startsWith("\\")) {
			n++;
		}
	}
	return files;
}

/** Everything the commit will contain, as [{file, lines:[{n,text}]}]. */
export function contentToCommit(repo, plan) {
	const chunks = addedLines(git(repo, ["diff", "--cached", "-U0", "--no-color"]));
	const tracked = plan.all || plan.addAll || plan.addTracked ? [] : plan.addPaths;
	if (plan.all || plan.addAll || plan.addTracked || plan.addPaths.length) {
		const args = ["diff", "-U0", "--no-color"];
		if (!(plan.all || plan.addAll || plan.addTracked)) args.push("--", ...tracked);
		chunks.push(...addedLines(git(repo, args)));
	}
	if (plan.addAll || plan.addPaths.length) {
		const args = ["ls-files", "--others", "--exclude-standard"];
		if (!plan.addAll) args.push("--", ...plan.addPaths);
		for (const f of git(repo, args).split("\n").filter(Boolean)) {
			const abs = path.join(repo, f);
			try {
				if (statSync(abs).size > 1_000_000) continue;
				const text = readFileSync(abs, "utf8");
				if (text.includes("\u0000")) continue; // binary
				chunks.push({ file: f, lines: text.split("\n").map((t, i) => ({ n: i + 1, text: t })) });
			} catch {
				/* unreadable: skip */
			}
		}
	}
	return chunks;
}

// ---------------------------------------------------------------------------------------------------------------
// Directory-aware commit plans: which repo each commit in a command line runs in, through wrappers (env, command,
// sudo, "\git", /usr/bin/git) and directory changes (cd, pushd, env -C, sudo -D, git -C). When the directory can't
// be determined, it says so (dir: null + a reason) — callers must not guess or fall back to another directory.

/** Index just past the `$( … )` or backtick substitution that starts at s[i] (nesting and quotes respected). */
function substitutionEnd(s, i) {
	if (s[i] === "`") {
		const j = s.indexOf("`", i + 1);
		return j === -1 ? s.length : j + 1;
	}
	let depth = 1; // s[i] is the opening "("
	let q = null;
	for (let j = i + 1; j < s.length; j++) {
		const ch = s[j];
		if (q) {
			if (ch === q) q = null;
			continue;
		}
		if (ch === "'" || ch === '"') q = ch;
		else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return j + 1;
	}
	return s.length;
}

/** Like splitCommands, but keeps the operator after each part ([{text, op}], op "&&" | "||" | ";" | "|" | "\n" |
 *  null) and doesn't split inside a `$( … )` or backtick substitution. */
export function splitWithOps(line) {
	const parts = [];
	let cur = "";
	let q = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (q) {
			cur += ch;
			if (ch === q) q = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			q = ch;
			cur += ch;
			continue;
		}
		if ((ch === "$" && line[i + 1] === "(") || ch === "`") {
			const end = substitutionEnd(line, ch === "$" ? i + 1 : i);
			cur += line.slice(i, end);
			i = end - 1;
			continue;
		}
		const two = line.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			parts.push({ text: cur, op: two });
			cur = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "\n") {
			parts.push({ text: cur, op: ch });
			cur = "";
			continue;
		}
		cur += ch;
	}
	parts.push({ text: cur, op: null });
	return parts.map((p) => ({ text: p.text.trim(), op: p.op })).filter((p) => p.text);
}

/**
 * The words of a simple command the way the shell splits them, without expanding anything: quotes are removed
 * and may be part of a word (--chdir="my dir"), a backslash escapes the next character (\git → git), and a
 * `$( … )` or backtick substitution stays inside its word, unexpanded.
 */
export function shellWords(cmd) {
	const out = [];
	let cur = "";
	let inWord = false;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (/\s/.test(ch)) {
			if (inWord) out.push(cur);
			cur = "";
			inWord = false;
			continue;
		}
		inWord = true;
		if (ch === "\\") {
			cur += cmd[i + 1] ?? "";
			i++;
		} else if (ch === "'") {
			const j = cmd.indexOf("'", i + 1);
			const end = j === -1 ? cmd.length : j;
			cur += cmd.slice(i + 1, end);
			i = end;
		} else if (ch === '"') {
			let j = i + 1;
			for (; j < cmd.length && cmd[j] !== '"'; j++) {
				if (cmd[j] === "\\" && /[$`"\\]/.test(cmd[j + 1] ?? "")) cur += cmd[++j];
				else if ((cmd[j] === "$" && cmd[j + 1] === "(") || cmd[j] === "`") {
					const end = substitutionEnd(cmd, cmd[j] === "$" ? j + 1 : j);
					cur += cmd.slice(j, end);
					j = end - 1;
				} else cur += cmd[j];
			}
			i = j;
		} else if ((ch === "$" && cmd[i + 1] === "(") || ch === "`") {
			const end = substitutionEnd(cmd, ch === "$" ? i + 1 : i);
			cur += cmd.slice(i, end);
			i = end - 1;
		} else cur += ch;
	}
	if (inWord) out.push(cur);
	return out;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Environment variables that point git at another repository. */
const GIT_REPO_VARS = ["GIT_DIR", "GIT_WORK_TREE"];
/** Options that take a value (getopt rules): short letters and long names. sudo -D / --chdir and env -C / --chdir
 *  also change the directory; env -S / --split-string holds a whole command line. */
const SUDO_VALUE = { short: "ughCDRTpUrt", long: ["--user", "--group", "--host", "--close-from", "--chdir", "--chroot", "--command-timeout", "--prompt", "--other-user", "--role", "--type"] };
const ENV_VALUE = { short: "uCSa", long: ["--unset", "--chdir", "--split-string", "--argv0"] };

/** A command word without a leading "\" or a path: "\git" → "git", "/usr/bin/git" → "git". */
const commandName = (w) => {
	const s = String(w ?? "").replace(/^\\/, "");
	return s.includes("/") ? path.posix.basename(s) : s;
};

/**
 * The option word at w[i], read with getopt rules: a short cluster is walked letter by letter, and at a letter that
 * takes a value the rest of the cluster is the value (or the next word if the cluster ends there); a long option
 * takes "--name=value" or "--name value". Returns {next, opts: [[name, value | undefined]]}, names like "-u" or "--user".
 */
function readOption(w, i, { short, long }) {
	const a = w[i];
	if (a.startsWith("--")) {
		const eq = a.indexOf("=");
		const name = eq === -1 ? a : a.slice(0, eq);
		if (!long.includes(name)) return { next: i + 1, opts: [[name, undefined]] };
		return eq === -1 ? { next: i + 2, opts: [[name, w[i + 1]]] } : { next: i + 1, opts: [[name, a.slice(eq + 1)]] };
	}
	const opts = [];
	for (let k = 1; k < a.length; k++) {
		const letter = a[k];
		if (short.includes(letter)) {
			const rest = a.slice(k + 1);
			return rest ? { next: i + 1, opts: [...opts, [`-${letter}`, rest]] } : { next: i + 2, opts: [...opts, [`-${letter}`, w[i + 1]]] };
		}
		opts.push([`-${letter}`, undefined]);
	}
	return { next: i + 1, opts };
}

/**
 * The command a segment really runs, with wrappers removed, in any order and nested: leading VAR=value words,
 * `env` (its options and VAR=value words), `command`, `sudo` (its options, including ones that take a value),
 * then a leading "\" or a path on the command word (/usr/bin/git → git).
 * @param {string | string[]} seg a simple command, or its words
 * @return {{words: string[], chdirs: string[], split: ?string, gitRepoVar: ?string}} words[0] is the command name
 *   ([] if nothing runs, e.g. `command -v git`); chdirs: directories set by `env -C` / `sudo -D`, in order; split:
 *   an `env -S` string (not parsed); gitRepoVar: GIT_DIR / GIT_WORK_TREE if one is assigned for the command.
 */
export function normalizeCommand(seg) {
	const w = Array.isArray(seg) ? seg : shellWords(seg);
	const chdirs = [];
	let gitRepoVar = null;
	const assign = (a) => {
		const name = a.slice(0, a.indexOf("="));
		if (GIT_REPO_VARS.includes(name)) gitRepoVar = name;
	};
	let i = 0;
	for (;;) {
		while (i < w.length && ASSIGN.test(w[i])) assign(w[i++]);
		const name = commandName(w[i]);
		if (name === "env") {
			i++;
			while (i < w.length) {
				const a = w[i];
				if (a === "--") {
					i++;
					break;
				}
				if (a === "-") {
					i++; // same as -i
					continue;
				}
				if (a.startsWith("-")) {
					const r = readOption(w, i, ENV_VALUE);
					for (const [opt, value] of r.opts) {
						if (opt === "-S" || opt === "--split-string") return { words: [], chdirs, split: value ?? "", gitRepoVar };
						if (opt === "-C" || opt === "--chdir") chdirs.push(value);
					}
					i = r.next;
				} else if (ASSIGN.test(a)) assign(w[i++]);
				else break;
			}
			continue;
		}
		if (name === "command") {
			i++;
			while (w[i] === "-p") i++;
			if (w[i] === "-v" || w[i] === "-V") return { words: [], chdirs, split: null, gitRepoVar }; // looks it up, runs nothing
			continue;
		}
		if (name === "sudo") {
			i++;
			while (i < w.length && w[i].startsWith("-")) {
				if (w[i] === "--") {
					i++;
					break;
				}
				const r = readOption(w, i, SUDO_VALUE);
				for (const [opt, value] of r.opts) if (opt === "-D" || opt === "--chdir") chdirs.push(value);
				i = r.next;
			}
			continue;
		}
		break;
	}
	const rest = w.slice(i);
	if (rest.length) rest[0] = commandName(rest[0]);
	return { words: rest, chdirs, split: null, gitRepoVar };
}

/**
 * Where a directory argument leads from `base`: {dir} (it exists and is a directory) or {unresolved: reason}.
 * Resolves a bare `cd` (undefined) to home, `~` and `~/x`, $HOME / ${HOME}, $CLAUDE_PROJECT_DIR, and relative paths
 * against `base` (null = unknown). Anything else that the shell would expand (another variable, a command
 * substitution, a glob, `-`, `~user`) or a path that doesn't exist is unresolved.
 */
export function resolveDir(arg, base, { home = homedir(), env = process.env } = {}) {
	if (arg === undefined) return { dir: home };
	if (arg === "-") return { unresolved: "`cd -` (the previous directory isn't tracked)" };
	let p = arg;
	if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
	else if (p.startsWith("~")) return { unresolved: `${arg} (another user's home)` };
	const v = /^\$(?:\{(HOME|CLAUDE_PROJECT_DIR)\}|(HOME|CLAUDE_PROJECT_DIR)(?![A-Za-z0-9_]))/.exec(p);
	if (v) {
		const name = v[1] || v[2];
		const val = name === "HOME" ? home : env.CLAUDE_PROJECT_DIR;
		if (!val) return { unresolved: `${arg} ($${name} isn't set)` };
		p = val + p.slice(v[0].length);
	}
	if (/[$`]/.test(p)) return { unresolved: `${arg} (a variable or command substitution)` };
	if (/[*?[]/.test(p)) return { unresolved: `${arg} (a glob pattern)` };
	if (!path.isAbsolute(p) && base === null) return { unresolved: `${arg} (relative to a directory that isn't known)` };
	const dir = path.resolve(base ?? "/", p);
	try {
		if (!statSync(dir).isDirectory()) return { unresolved: `${arg} (not a directory)` };
	} catch {
		return { unresolved: `${arg} (doesn't exist)` };
	}
	return { dir };
}

/** The effect of cd / pushd / popd from `base`: {dir}, {unresolved}, or {keep: true} (no change). */
function changeDir(cmd, args, base, opts) {
	if (cmd === "popd") return { unresolved: "popd (the directory stack isn't tracked)" };
	let a = args;
	if (cmd === "cd") {
		while (a.length && /^-[LPe@]+$/.test(a[0])) a = a.slice(1);
		if (a[0] === "--") a = a.slice(1);
		if (a.length > 1) return { unresolved: `cd ${a.join(" ")} (more than one argument)` };
		return resolveDir(a[0], base, opts);
	}
	if (a.includes("-n")) return { keep: true }; // pushd -n only changes the stack
	if (!a.length) return { unresolved: "pushd with no directory (the directory stack isn't tracked)" };
	if (/^[+-]\d+$/.test(a[0])) return { unresolved: `pushd ${a[0]} (the directory stack isn't tracked)` };
	return resolveDir(a[0], base, opts);
}

/** A last word without the ")" that closes a subshell — but not one that closes a "$( … )": {word, closes}. */
function closeParens(word) {
	let x = word;
	let closes = 0;
	const count = (s, c) => s.split(c).length - 1;
	while (x.endsWith(")") && count(x, ")") > count(x, "(")) {
		x = x.slice(0, -1);
		closes++;
	}
	return { word: x, closes };
}

/**
 * Each simple command in a line, normalised, with the directory it runs in: [{text, words, dir, why, split,
 * gitRepoVar}]. dir null = unknown (why says why). cd / pushd follow the shell: they last for the rest of the line,
 * except in a pipeline stage (its own subshell). `env -C` / `sudo -D` apply to their own command only.
 * ( … ) runs in a subshell: a cd / pushd / popd inside makes the commands after it, inside, unknown; after the
 * closing ")" the directory from before the subshell is back. { … } runs in the same shell, so a cd inside carries on.
 * @param {string} line
 * @param {{cwd: string, home?: string, env?: object}} opts cwd = where the line starts
 */
export function trackCommands(line, { cwd, home = homedir(), env = process.env } = {}) {
	const opts = { home, env };
	const parts = splitWithOps(line);
	let dir = cwd;
	let why = null;
	const frames = []; // open subshells "(" and groups "{", with the directory from before them
	const out = [];
	parts.forEach((p, k) => {
		const pipeline = p.op === "|" || (k > 0 && parts[k - 1].op === "|");
		let w = shellWords(p.text);
		for (;;) {
			if (w[0] === "{") {
				frames.push({ kind: "{", dir, why });
				w = w.slice(1);
			} else if (w[0]?.startsWith("(")) {
				frames.push({ kind: "(", dir, why });
				w = [w[0].slice(1), ...w.slice(1)].filter((x, j) => j > 0 || x);
			} else break;
		}
		const closes = [];
		for (;;) {
			const last = w[w.length - 1];
			if (last === "}") {
				closes.unshift("}");
				w = w.slice(0, -1);
				continue;
			}
			const c = last === undefined ? { closes: 0 } : closeParens(last);
			if (!c.closes) break;
			for (let n = 0; n < c.closes; n++) closes.unshift(")");
			w = [...w.slice(0, -1), c.word].filter((x, j, all) => j < all.length - 1 || x);
		}
		const n = normalizeCommand(w);
		let segDir = dir;
		let segWhy = why;
		for (const c of n.chdirs) {
			const r = resolveDir(c, segDir, opts);
			segDir = r.dir ?? null;
			segWhy = r.dir ? null : `env -C / sudo -D ${r.unresolved}`;
		}
		const cmd = n.words[0];
		if ((cmd === "cd" || cmd === "pushd" || cmd === "popd") && !pipeline) {
			const r = changeDir(cmd, n.words.slice(1), segDir, opts);
			if (frames.some((f) => f.kind === "(")) {
				dir = null;
				why = `${cmd} inside a ( … ) subshell (commands after it there aren't tracked)`;
			} else if (!r.keep) {
				dir = r.dir ?? null;
				why = r.dir ? null : r.unresolved;
			}
		}
		if (n.words.length || n.split !== null) out.push({ text: p.text, words: n.words, dir: segDir, why: segWhy, split: n.split, gitRepoVar: n.gitRepoVar });
		for (const c of closes) {
			const kind = c === ")" ? "(" : "{";
			let idx = frames.length - 1;
			while (idx >= 0 && frames[idx].kind !== kind) idx--;
			if (idx === -1) continue;
			const [f] = frames.splice(idx);
			if (f.kind === "(") {
				dir = f.dir;
				why = f.why;
			}
		}
	});
	return out;
}

/** git's global options before the subcommand: {sub, args, chdirs, other} — or null if it isn't git. other names a
 *  --git-dir / --work-tree option (it points git at another repo). */
export function parseGit(nwords) {
	if (nwords[0] !== "git") return null;
	let i = 1;
	const chdirs = [];
	let other = null;
	while (i < nwords.length && nwords[i].startsWith("-")) {
		const a = nwords[i];
		if (a === "-C") {
			chdirs.push(nwords[i + 1]);
			i += 2;
		} else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(a)) {
			other = `git ${a.split("=")[0]}`;
			i += a.includes("=") ? 1 : 2;
		} else if (a === "-c" || a === "--namespace" || a === "--config-env") {
			i += 2;
		} else {
			i++;
		}
	}
	return nwords[i] ? { sub: nwords[i], args: nwords.slice(i + 1), chdirs, other } : null;
}

/**
 * Every commit a command line makes, with the repo directory it runs in:
 *   [{dir, unresolved, all, addAll, addTracked, addPaths}] — dir null when it can't be determined (unresolved says
 *   why; callers must ask, never scan another directory), plus {unparsable: "env -S"} for an `env -S` string that
 *   mentions git. A `git add` counts only toward a later commit in the same directory.
 * @param {string} line
 * @param {{cwd: string, home?: string, env?: object}} opts cwd = where the line starts
 */
export function commitPlans(line, opts) {
	const resolveOpts = { home: opts.home ?? homedir(), env: opts.env ?? process.env };
	const plans = [];
	const pending = new Map(); // directory → git add info not yet committed
	const key = (d) => d ?? "\0unknown";
	for (const s of trackCommands(line, opts)) {
		if (s.split !== null) {
			if (/\bgit\b/.test(s.split)) plans.push({ unparsable: "env -S" });
			continue;
		}
		const g = parseGit(s.words);
		if (!g) continue;
		let dir = s.dir;
		let why = s.why;
		for (const c of g.chdirs) {
			const r = resolveDir(c, dir, resolveOpts);
			dir = r.dir ?? null;
			why = r.dir ? null : `git -C ${r.unresolved}`;
		}
		if (g.other || s.gitRepoVar) {
			dir = null;
			why = g.other ? `${g.other} (points git at another repository)` : `${s.gitRepoVar}=… (points git at another repository)`;
		}
		const add = pending.get(key(dir)) || { addAll: false, addTracked: false, addPaths: [] };
		if (g.sub === "add") {
			for (const a of g.args) {
				if (a === "-A" || a === "--all" || a === ".") add.addAll = true;
				else if (a === "-u" || a === "--update") add.addTracked = true;
				else if (!a.startsWith("-")) add.addPaths.push(a);
			}
			pending.set(key(dir), add);
		}
		if (g.sub === "commit") {
			const all = g.args.some((a) => a === "--all" || /^-[A-Za-z]*a[A-Za-z]*$/.test(a));
			plans.push({ dir, unresolved: dir === null ? why || "unknown directory" : null, all, ...add });
			pending.delete(key(dir));
		}
	}
	return plans;
}
