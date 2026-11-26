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

// ---- scan budget -------------------------------------------------------------------------------------------------
// A hook that times out lets the commit through on Claude Code versions without `onFailure: "block"`, so the content
// scan has a budget of its own, sized well inside the hook's timeout. A git call that runs out of time throws
// ScanTimeout; callers turn that into "ask", never a silent pass.

/** Thrown when a content-scan call runs out of time. */
export class ScanTimeout extends Error {}

/**
 * A time budget for one hook run: {deadline, now, runGit, left()}. runGit / now are for tests (the git runner, same
 * shape as runGitDefault, and the clock).
 */
export function scanBudget(ms, { now = Date.now, runGit = runGitDefault } = {}) {
	const deadline = now() + ms;
	return { deadline, now, runGit, left: () => deadline - now() };
}

/** git within the budget: stdout ("" when git fails); throws ScanTimeout when the budget is spent or the call times out. */
export function scanGit(budget, cwd, args) {
	const left = budget.left();
	if (left <= 0) throw new ScanTimeout(`no time left for git ${args[0]}`);
	const r = budget.runGit(args, { cwd, timeout: left });
	if (r.timedOut) throw new ScanTimeout(`git ${args[0]} timed out`);
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

/**
 * Everything the commit will contain, as [{file, lines:[{n,text}]}].
 * @param {object} [budget] from scanBudget(); without one, git calls have no timeout. With one, throws ScanTimeout
 *   when a git call times out or the budget runs out (checked before each git call and each untracked file).
 */
export function contentToCommit(repo, plan, budget) {
	const run = budget ? (cwd, args) => scanGit(budget, cwd, args) : git;
	const chunks = addedLines(run(repo, ["diff", "--cached", "-U0", "--no-color"]));
	const tracked = plan.all || plan.addAll || plan.addTracked ? [] : plan.addPaths;
	if (plan.all || plan.addAll || plan.addTracked || plan.addPaths.length) {
		const args = ["diff", "-U0", "--no-color"];
		if (!(plan.all || plan.addAll || plan.addTracked)) args.push("--", ...tracked);
		chunks.push(...addedLines(run(repo, args)));
	}
	if (plan.addAll || plan.addPaths.length) {
		const args = ["ls-files", "--others", "--exclude-standard"];
		if (!plan.addAll) args.push("--", ...plan.addPaths);
		for (const f of run(repo, args).split("\n").filter(Boolean)) {
			if (budget && budget.left() <= 0) throw new ScanTimeout("no time left to read untracked files");
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
/** Environment variables that change which git config (and so which aliases) git reads. */
const GIT_CONFIG_VARS = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_COUNT"]);
const isGitConfigVar = (name) => GIT_CONFIG_VARS.has(name) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name);
/** Of those, the ones holding a path (a relative value is relative to the command's directory). */
const GIT_CONFIG_PATH_VARS = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "HOME", "XDG_CONFIG_HOME"]);
/** Options that take a value (getopt rules): short letters and long names. sudo -D / --chdir and env -C / --chdir
 *  also change the directory; env -S / --split-string holds a whole command line. */
const SUDO_VALUE = { short: "ughCDRTpUrt", long: ["--user", "--group", "--host", "--close-from", "--chdir", "--chroot", "--command-timeout", "--prompt", "--other-user", "--role", "--type"] };
const ENV_VALUE = { short: "uCSa", long: ["--unset", "--chdir", "--split-string", "--argv0"] };
/** Shell keywords and "!" that can start a segment before the real command (`if git commit …; then`, `! git commit`). */
const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "do", "while", "until", "{"]);
/** Commands that run the rest of the line as a command: their options (getopt rules: value-taking letters and long
 *  names), and how many positional words they take before the command (timeout DURATION, taskset MASK/LIST). chrt's
 *  priority is optional and only skipped when numeric. */
const RUNNERS = {
	time: { short: "fo", long: ["--format", "--output"], positional: 0 },
	nohup: { short: "", long: [], positional: 0 },
	setsid: { short: "", long: [], positional: 0 },
	exec: { short: "a", long: [], positional: 0 },
	timeout: { short: "sk", long: ["--signal", "--kill-after"], positional: 1 },
	nice: { short: "n", long: ["--adjustment"], positional: 0 },
	ionice: { short: "cnp", long: ["--class", "--classdata", "--pid", "--pgid", "--uid"], positional: 0 },
	stdbuf: { short: "ioe", long: ["--input", "--output", "--error"], positional: 0 },
	chrt: { short: "TPD", long: ["--sched-runtime", "--sched-period", "--sched-deadline"], positional: 0, numeric: true },
	taskset: { short: "", long: [], positional: 1 }
};
/** Shells whose `-c '<string>'` runs a command line the hooks don't parse (yet). */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

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
 * The command a segment really runs, with wrappers removed, in any order and nested: leading VAR=value words;
 * shell keywords and "!" (if, then, else, elif, do, while, until, "{"); `env` (its options and VAR=value words),
 * `command`, `sudo` (its options, including ones that take a value), `time`, `nohup`, `setsid`, `exec`, `timeout`
 * (and its DURATION), `nice`, `ionice`, `stdbuf`, `chrt` (and its priority), `taskset` (and its mask or list);
 * then a leading "\" or a path on the command word (/usr/bin/git → git).
 * @param {string | string[]} seg a simple command, or its words
 * @return {{words: string[], chdirs: string[], split: ?string, gitRepoVar: ?string, envPrefix: object}} words[0] is the command name
 *   ([] if nothing runs, e.g. `command -v git`); chdirs: directories set by `env -C` / `sudo -D`, in order; split:
 *   an `env -S` string (not parsed); gitRepoVar: GIT_DIR / GIT_WORK_TREE if one is assigned for the command;
 *   envPrefix: git config variables (GIT_CONFIG_GLOBAL, HOME, GIT_CONFIG_KEY_n …) assigned for it, as written.
 */
export function normalizeCommand(seg) {
	const w = Array.isArray(seg) ? seg : shellWords(seg);
	const chdirs = [];
	let gitRepoVar = null;
	const envPrefix = {}; // git config variables set for this command (VAR=value or env VAR=value)
	const assign = (a) => {
		const name = a.slice(0, a.indexOf("="));
		if (GIT_REPO_VARS.includes(name)) gitRepoVar = name;
		if (isGitConfigVar(name)) envPrefix[name] = a.slice(a.indexOf("=") + 1);
	};
	let i = 0;
	for (;;) {
		while (i < w.length && ASSIGN.test(w[i])) assign(w[i++]);
		if (KEYWORDS.has(w[i])) {
			i++;
			continue;
		}
		const name = commandName(w[i]);
		const runner = Object.hasOwn(RUNNERS, name) ? RUNNERS[name] : null;
		if (runner) {
			i++;
			while (i < w.length && w[i].startsWith("-") && w[i] !== "-") {
				if (w[i] === "--") {
					i++;
					break;
				}
				if (name === "nice" && /^-\d+$/.test(w[i])) i++; // nice -5 (old form)
				else i = readOption(w, i, runner).next;
			}
			i += runner.positional;
			if (runner.numeric && /^\d+$/.test(w[i] ?? "")) i++;
			continue;
		}
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
						if (opt === "-S" || opt === "--split-string") return { words: [], chdirs, split: value ?? "", gitRepoVar, envPrefix };
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
			if (w[i] === "-v" || w[i] === "-V") return { words: [], chdirs, split: null, gitRepoVar, envPrefix }; // looks it up, runs nothing
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
	return { words: rest, chdirs, split: null, gitRepoVar, envPrefix };
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
export function trackCommands(line, { cwd, why: startWhy = null, home = homedir(), env = process.env, envState: startEnv = {} } = {}) {
	const opts = { home, env };
	const parts = splitWithOps(line);
	let dir = cwd ?? null;
	let why = dir === null ? startWhy : null;
	// Exported git config variables (GIT_CONFIG_GLOBAL, HOME …) as the shell would pass them to git: name → value,
	// or null for unset. shellVars: plain `VAR=value` assignments, which `export VAR` can export later.
	let envState = { ...startEnv };
	let shellVars = {};
	const frames = []; // open subshells "(" and groups "{", with the directory and env from before them
	const out = [];
	parts.forEach((p, k) => {
		const pipeline = p.op === "|" || (k > 0 && parts[k - 1].op === "|");
		let w = shellWords(p.text);
		for (;;) {
			if (w[0] === "{") {
				frames.push({ kind: "{", dir, why, envState, shellVars });
				w = w.slice(1);
			} else if (w[0]?.startsWith("(")) {
				frames.push({ kind: "(", dir, why, envState: { ...envState }, shellVars: { ...shellVars } });
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
		if (!pipeline) {
			if (!n.words.length && n.split === null) {
				// VAR=value on its own: a shell variable; it changes the environment only if already exported
				for (const [name, value] of Object.entries(n.envPrefix)) {
					shellVars[name] = value;
					if ((name in envState && envState[name] !== null) || (!(name in envState) && env[name] !== undefined)) envState[name] = value;
				}
			} else if (cmd === "export" || cmd === "unset") {
				const args = n.words.slice(1).filter((a) => !/^-[a-z]+$/.test(a) || a === "-n");
				const unexport = cmd === "unset" || n.words.includes("-n");
				for (const a of args) {
					if (a === "-n") continue;
					const eq = a.indexOf("=");
					const name = eq === -1 ? a : a.slice(0, eq);
					if (!isGitConfigVar(name)) continue;
					if (unexport) envState[name] = null;
					else if (eq !== -1) envState[name] = shellVars[name] = a.slice(eq + 1);
					else if (name in shellVars) envState[name] = shellVars[name];
				}
			}
		}
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
		if (n.words.length || n.split !== null) out.push({ text: p.text, words: n.words, dir: segDir, why: segWhy, split: n.split, gitRepoVar: n.gitRepoVar, envPrefix: { ...envState, ...n.envPrefix } });
		for (const c of closes) {
			const kind = c === ")" ? "(" : "{";
			let idx = frames.length - 1;
			while (idx >= 0 && frames[idx].kind !== kind) idx--;
			if (idx === -1) continue;
			const [f] = frames.splice(idx);
			if (f.kind === "(") {
				dir = f.dir;
				why = f.why;
				envState = f.envState;
				shellVars = f.shellVars;
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
	const configs = []; // -c key=value
	const configEnv = []; // --config-env key=ENVVAR
	let other = null;
	while (i < nwords.length && nwords[i].startsWith("-")) {
		const a = nwords[i];
		if (a === "-C") {
			chdirs.push(nwords[i + 1]);
			i += 2;
		} else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(a)) {
			other = `git ${a.split("=")[0]}`;
			i += a.includes("=") ? 1 : 2;
		} else if (a === "-c") {
			if (nwords[i + 1] !== undefined) configs.push(nwords[i + 1]);
			i += 2;
		} else if (a === "--config-env" || a.startsWith("--config-env=")) {
			const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : nwords[i + 1];
			if (v !== undefined) configEnv.push(v);
			i += a.includes("=") ? 1 : 2;
		} else if (a === "--namespace") {
			i += 2;
		} else {
			i++;
		}
	}
	return nwords[i] ? { sub: nwords[i], args: nwords.slice(i + 1), chdirs, other, configs, configEnv } : null;
}

// ---- git aliases -------------------------------------------------------------------------------------------------
// git runs an alias only when the subcommand isn't a real command (a builtin or a git-* program on PATH), so the
// real commands are a fixed list of builtins (no spawn) plus, for anything else, `git --list-cmds=main,others`,
// asked lazily and cached per runner and PATH. Each git call has a 2 s timeout and all alias work in one
// commitPlans() call shares a ~5 s budget; a timeout, an exhausted budget or an unexpected git failure means
// "can't parse this commit" (ask), never a silent pass.

const ALIAS_CALL_MS = 2000;
const ALIAS_BUDGET_MS = 5000;
const ALIAS_DEPTH = 5;
const commandCache = new WeakMap(); // runner → Map(PATH → Set of real commands)

/** The real git runner: {status, stdout, timedOut}. Tests pass their own with the same shape. SIGKILL on timeout, so
 *  a git that ignores SIGTERM can't hold the hook. */
export function runGitDefault(args, { cwd, env, timeout }) {
	const r = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout, killSignal: "SIGKILL" });
	return { status: r.status, stdout: r.stdout || "", timedOut: r.error?.code === "ETIMEDOUT" };
}

/** Thrown inside alias resolution to mean "ask: can't parse this commit". */
class Unparsable extends Error {}

/** A git call within the per-call timeout and the shared budget; throws Unparsable on timeout or budget. */
function aliasGit(ctx, args, cwd, env = ctx.env) {
	const left = ctx.deadline - ctx.now();
	if (left <= 0) throw new Unparsable("git alias lookups ran out of time");
	const r = ctx.runGit(args, { cwd, env, timeout: Math.min(ALIAS_CALL_MS, left) });
	if (r.timedOut) throw new Unparsable(`git ${args[0]} timed out`);
	return r;
}

/** Is `sub` a real git command (so git ignores any alias with that name)? */
/** Git commands that are always real (builtins), so they never need `git --list-cmds`. */
const KNOWN_COMMANDS = new Set(["status", "log", "diff", "show", "push", "pull", "fetch", "branch", "switch", "checkout", "restore", "merge", "rebase", "stash", "tag", "remote", "config", "rev-parse", "ls-files", "reset", "clean", "init", "clone", "add", "commit", "help", "version", "grep", "blame", "describe", "cherry-pick", "revert", "bisect", "worktree", "submodule", "am", "apply", "format-patch", "notes", "reflog", "gc", "fsck", "mv", "rm"]);

function isRealCommand(ctx, sub, cwd) {
	if (KNOWN_COMMANDS.has(sub)) return true;
	let byPath = commandCache.get(ctx.runGit);
	if (!byPath) commandCache.set(ctx.runGit, (byPath = new Map()));
	const key = ctx.env.PATH ?? "";
	if (!byPath.has(key)) {
		const r = aliasGit(ctx, ["--list-cmds=main,others"], cwd);
		if (r.status !== 0) throw new Unparsable("couldn't list git's commands");
		byPath.set(key, new Set(r.stdout.split("\n").map((x) => x.trim()).filter(Boolean)));
	}
	return byPath.get(key).has(sub);
}

/**
 * Expands git aliases the way git does, up to ALIAS_DEPTH levels: an inline `-c alias.<sub>=…` first, else
 * `git -C <dir> config --get alias.<sub>` (system, global and included configs count). Returns
 * {g, dir} (g = the command git really runs; its sub may still be anything) | {unresolved: reason}.
 * Throws Unparsable for a shell alias that runs `git … commit`, `--config-env alias.*`, a loop or too many levels.
 */
function expandAliases(g, dir, ctx, resolveOpts, cmdEnv = {}) {
	const seen = new Set();
	for (let depth = 0; ; depth++) {
		if (isRealCommand(ctx, g.sub, dir ?? ctx.cwd)) return { g, dir };
		const name = `alias.${g.sub}`.toLowerCase();
		if (g.configEnv.some((c) => c.toLowerCase().startsWith(`${name}=`))) throw new Unparsable(`git --config-env ${name}`);
		const inline = [...g.configs].reverse().find((c) => c.toLowerCase().startsWith(`${name}=`));
		let value;
		if (inline !== undefined) value = inline.slice(name.length + 1);
		else {
			if (dir === null) return { unresolved: `git ${g.sub} (an alias in a repo that can't be determined)` };
			if (cmdEnv.dynamic) throw new Unparsable(`${cmdEnv.dynamic}=… uses a variable or substitution`);
			const lookupEnv = { ...ctx.env, ...cmdEnv.vars };
			for (const k of Object.keys(lookupEnv)) if (lookupEnv[k] === undefined) delete lookupEnv[k];
			const r = aliasGit(ctx, ["config", "--get", name], dir, lookupEnv);
			if (r.status === 1) return { g, dir }; // not an alias: git would say "not a git command"
			if (r.status !== 0) throw new Unparsable(`git config --get ${name} failed`);
			value = r.stdout.replace(/\n$/, "");
		}
		if (value.startsWith("!")) {
			// A shell alias is a whole shell line (often `sh -c '…'` or a function that runs `git "$@"`), so it can
			// commit without the word appearing: any shell alias that runs git asks.
			if (/\bgit\b/.test(value)) throw new Unparsable(`shell alias ${name} runs git`);
			return { g: { ...g, sub: "!shell-alias", args: [] }, dir }; // doesn't run git: no commit
		}
		if (seen.has(name) || depth >= ALIAS_DEPTH) throw new Unparsable(`alias ${name} loops or nests too deep`);
		seen.add(name);
		const next = parseGit(["git", ...shellWords(value), ...g.args]);
		if (!next) return { g: { ...g, sub: "!empty-alias", args: [] }, dir };
		for (const c of next.chdirs) {
			const r = resolveDir(c, dir, resolveOpts);
			if (!r.dir) return { unresolved: `git -C ${r.unresolved} (inside alias ${name})` };
			dir = r.dir;
		}
		if (next.other) return { unresolved: `${next.other} (inside alias ${name}; points git at another repository)` };
		g = { ...next, configs: [...g.configs, ...next.configs], configEnv: [...g.configEnv, ...next.configEnv] };
	}
}

/** Do the words hold `git` (by command name) and, later, `commit`, as separate words? */
export function mentionsCommit(ws) {
	const g = ws.findIndex((x) => commandName(x) === "git");
	return g !== -1 && ws.indexOf("commit", g + 1) !== -1;
}

/** The '<string>' of `bash -c '<string>'` (also -lc, -ec …: any short cluster with c), or null. */
function shellCommandString(ws) {
	let c = false;
	for (let i = 1; i < ws.length; i++) {
		const a = ws[i];
		if (a === "-o" || a === "+o") i++; // set -o OPTION
		else if (/^[-+][A-Za-z]+$/.test(a)) c ||= a.slice(1).includes("c");
		else if (a === "--") continue;
		else return c ? a : null;
	}
	return null;
}

/** An unresolved reason "<command fragment> (<why>)" with the fragment cut to about `max` characters ("…" when cut). */
export function capFragment(reason, max = 60) {
	const i = reason.endsWith(")") ? reason.lastIndexOf(" (") : -1;
	const fragment = i > 0 ? reason.slice(0, i) : reason;
	const why = i > 0 ? reason.slice(i) : "";
	return (fragment.length > max ? `${fragment.slice(0, max - 1)}…` : fragment) + why;
}

/** How deep `bash -c '…'` / `eval '…'` strings are parsed inside each other; deeper (with git in it) → ask. */
const MAX_NEST = 3;
/** xargs options that take a value (getopt rules). */
const XARGS_VALUE = { short: "adEILnPs", long: ["--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"] };

/** The command xargs runs: its words after xargs and xargs's options. */
function xargsCommand(words) {
	let i = 1;
	while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
		if (words[i] === "--") {
			i++;
			break;
		}
		i = readOption(words, i, XARGS_VALUE).next;
	}
	return words.slice(i);
}

/** The git config variables a command sets, ready for `git config`: {vars, dynamic} (dynamic names a variable
 *  whose value the hook can't know, e.g. GIT_CONFIG_GLOBAL=$X). Relative paths resolve against `dir`. */
function commandConfigEnv(envPrefix, dir, home) {
	const vars = {};
	let dynamic = null;
	for (const [name, raw] of Object.entries(envPrefix || {})) {
		if (raw === null) {
			vars[name] = undefined; // unset: removed from git's environment
			continue;
		}
		if (/[$`]/.test(raw)) {
			dynamic = name;
			continue;
		}
		let v = raw;
		if (GIT_CONFIG_PATH_VARS.has(name) && v) {
			if (v === "~" || v.startsWith("~/")) v = home + v.slice(1);
			else if (!path.isAbsolute(v)) {
				if (dir === null) {
					dynamic = name;
					continue;
				}
				v = path.resolve(dir, v);
			}
		}
		vars[name] = v;
	}
	return { vars, dynamic };
}

/**
 * What a git command really does: {g, dir, why} after its -C directories, GIT_DIR / --git-dir and aliases, or
 * {unresolved: reason} (an alias in a repo that can't be determined), or {unparsable: true}.
 */
function resolveGit(g, s, envPrefix, ctx, resolveOpts) {
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
	if (dir === null && g.sub === "commit") return { g, dir, why }; // a commit in an unknown repo keeps its reason
	try {
		const x = expandAliases(g, dir, ctx, resolveOpts, commandConfigEnv(envPrefix, s.dir, resolveOpts.home));
		return x.unresolved ? { unresolved: x.unresolved } : { g: x.g, dir: x.dir, why };
	} catch (e) {
		if (!(e instanceof Unparsable)) throw e;
		return { unparsable: true };
	}
}

/** The plans of one command line at nesting `depth` (0 = the hook's own line), sharing the alias context. */
function plansFor(line, opts, ctx, resolveOpts, depth) {
	const plans = [];
	const pending = new Map(); // directory → git add info not yet committed
	const key = (d) => d ?? "\0unknown";
	const nested = (inner, s) => {
		if (depth + 1 > MAX_NEST) return /\bgit\b/.test(inner) ? [{ unparsable: "commit" }] : [];
		return plansFor(inner, { ...opts, cwd: s.dir, why: s.why, envState: s.envPrefix }, ctx, resolveOpts, depth + 1);
	};
	for (const s of trackCommands(line, opts)) {
		if (s.split !== null) {
			if (/\bgit\b/.test(s.split)) plans.push({ unparsable: "env -S" });
			continue;
		}
		let g = parseGit(s.words);
		if (!g) {
			const w0 = s.words[0];
			// bash -c '…' / eval '…': the string is a command line of its own, parsed the same way (aliases too).
			const inner = SHELLS.has(w0) ? shellCommandString(s.words) : w0 === "eval" ? s.words.slice(1).join(" ") : null;
			if (inner !== null) {
				plans.push(...nested(inner, s));
				continue;
			}
			// xargs adds arguments the hook can't see: a commit it runs asks.
			if (w0 === "xargs") {
				const n = normalizeCommand(xargsCommand(s.words));
				const xs = { ...s, words: n.words, gitRepoVar: s.gitRepoVar || n.gitRepoVar };
				const xg = parseGit(n.words);
				const xinner = SHELLS.has(n.words[0]) ? shellCommandString(n.words) : n.words[0] === "eval" ? n.words.slice(1).join(" ") : null;
				let commits = false;
				if (xg) {
					const r = resolveGit(xg, xs, { ...s.envPrefix, ...n.envPrefix }, ctx, resolveOpts);
					commits = Boolean(r.unparsable || r.unresolved || r.g.sub === "commit");
				} else if (xinner !== null) commits = nested(xinner, xs).length > 0;
				else commits = mentionsCommit(n.words);
				if (commits) plans.push({ unparsable: "xargs" });
				continue;
			}
			// Fail safe: not a git command we recognise, but `git … commit` is in it as plain words (eval git commit,
			// parallel git commit …). Quoted strings are single words, so echo "git commit" doesn't count.
			if (mentionsCommit(s.words)) plans.push({ unparsable: "commit" });
			continue;
		}
		const r = resolveGit(g, s, s.envPrefix, ctx, resolveOpts);
		if (r.unparsable) {
			plans.push({ unparsable: "commit" });
			continue;
		}
		if (r.unresolved) {
			plans.push({ dir: null, unresolved: r.unresolved, all: false, addAll: false, addTracked: false, addPaths: [] });
			continue;
		}
		g = r.g;
		const { dir, why } = r;
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

/**
 * Every commit a command line makes, with the repo directory it runs in.
 *
 * Returns [{dir, unresolved, all, addAll, addTracked, addPaths}]. dir is null when it can't
 * be determined; unresolved says why, and callers must ask, never scan another directory.
 * Other entries:
 * - {unparsable: "env -S"}: an `env -S` string that mentions git
 * - {unparsable: "xargs"}: xargs runs a commit (its arguments come from input the hook
 *   can't see)
 * - {unparsable: "commit"}: a command that isn't git but has `git … commit` as plain words;
 *   a git alias that can't be followed safely (a shell alias running git commit, a loop, a
 *   timeout, a config variable set from $…); or `bash -c` / `eval` strings nested more than
 *   3 deep with git in them
 *
 * `bash|sh|zsh|dash|ksh -c '…'` and `eval '…'` strings are parsed as command lines of their
 * own (same directory, same alias budget). Git aliases are expanded the way git does
 * (`git ci` with alias.ci=commit is a commit), using the command's own GIT_CONFIG_* / HOME
 * prefixes. An alias in a repo that can't be determined is unresolved. A `git add` counts
 * only toward a later commit in the same directory.
 *
 * @param {string} line
 * @param {{cwd: string, home?: string, env?: object, runGit?: Function, now?: () => number}} opts
 *   cwd = where the line starts; runGit / now are for tests (the git runner and the clock for
 *   the alias lookups and their budget)
 */
export function commitPlans(line, opts) {
	const resolveOpts = { home: opts.home ?? homedir(), env: opts.env ?? process.env };
	const now = opts.now ?? Date.now;
	const ctx = { runGit: opts.runGit ?? runGitDefault, env: { ...process.env, ...(opts.env ?? {}) }, now, deadline: now() + ALIAS_BUDGET_MS, cwd: opts.cwd };
	return plansFor(line, opts, ctx, resolveOpts, 0);
}
