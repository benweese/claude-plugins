#!/usr/bin/env node
// guardrails PreToolUse hook on Bash:
//  - secrets (ON by default): before each `git commit` in the command, scan what it will commit — the index,
//    plus tracked changes for -a/--all, plus paths a chained `git add …` stages — in the repo it runs in
//    (following cd, pushd, env -C, sudo -D, git -C and wrappers like env / command / sudo), with gitleaks if
//    installed, else built-in patterns. A match → deny (the commit doesn't run), secrets masked. If the repo
//    can't be determined (cd "$X", cd -, popd, a missing folder …) or an env -S string mentions git → "ask".
//    The scan has a 40 s budget (the hook's timeout is 60 s): a git or gitleaks call that runs out of time → "ask".
//  - dangerous (opt-in): BLOCKED (deny): `gh pr merge`, `gh api` merges (the pulls/N/merge endpoint, GraphQL
//    mergePullRequest / enablePullRequestAutoMerge), any `git push` to the default branch (forced or not, deletes,
//    --all / --mirror, a bare push that lands there), and --force / -f / +refspec pushes to any other branch
//    (--force-with-lease is allowed there). ASKED: reset --hard, clean -fd, checkout -- ., restore ., rm -rf on
//    / ~ $HOME or the repo root. `bash -c '…'` strings are checked too. A speed bump: the wall is a branch ruleset.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { decision, defaultBranch, finish, git, loadConfig, projectDirOf, readInput } from "./lib.mjs";
import { isMain } from "./is-main.mjs";
import { capFragment, commitPlans, contentToCommit, parseGit, resolveDir, ScanTimeout, scanBudget, SHELLS, shellCommandString, trackCommands } from "./commit-content.mjs";

export { capFragment, commitPlans, addedLines, contentToCommit } from "./commit-content.mjs";

/** Why the secret check asks instead of scanning. */
export const ASK_UNRESOLVED = "can't tell which repo this commits in; secrets not checked";
export const ASK_SPLIT = "can't parse env -S; secrets not checked";
export const ASK_UNPARSED = "can't parse this commit; secrets not checked";
export const ASK_XARGS = "can't see xargs arguments; secrets not checked";
export const ASK_TIMEOUT = "secret scan timed out; secrets not checked";

/** The secret scan's time budget per hook run, well inside the hook's 60 s timeout (hooks/hooks.json). */
export const SCAN_BUDGET_MS = 40_000;
/** Longest `gitleaks version` may take. */
const GITLEAKS_VERSION_MS = 5_000;
/** Time kept back from gitleaks so the built-in patterns can still run if it times out. */
const reserveFor = (budgetMs) => Math.min(5_000, Math.floor(budgetMs / 4));

/** Built-in secret patterns (used when gitleaks isn't installed). */
export const SECRET_PATTERNS = [
	{ name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/ },
	{ name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
	{ name: "OpenAI API key", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/ },
	{ name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
	{ name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ name: "password or key assignment", re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i }
];

const mask = (s) => `${s.slice(0, 4)}…(${s.length} chars)`;

/** Built-in scan: [{file, line, rule, sample}]. */
export function scanBuiltIn(chunks) {
	const hits = [];
	for (const c of chunks) {
		for (const l of c.lines) {
			for (const p of SECRET_PATTERNS) {
				const m = p.re.exec(l.text);
				if (m) hits.push({ file: c.file, repo: c.repo, line: l.n, rule: p.name, sample: mask(m[0]) });
			}
		}
	}
	return hits;
}

/** gitleaks on PATH? "yes" | "no" | "timeout" (no time left, or `gitleaks version` didn't answer in time). */
function hasGitleaks(timeout) {
	if (timeout <= 0) return "timeout";
	const r = spawnSync("gitleaks", ["version"], { encoding: "utf8", timeout, killSignal: "SIGKILL" });
	if (r.error?.code === "ETIMEDOUT") return "timeout";
	return r.status === 0 ? "yes" : "no";
}

/**
 * gitleaks scan of the chunks. Each file's added lines are written to a temp file (one folder per repo), and every
 * finding's StartLine — a line in that temp file — is mapped back to the real line number. Returns hits, null if
 * gitleaks failed, or "timeout" if it didn't finish within `timeout` ms (or there was no time to start it).
 */
function scanGitleaks(chunks, timeout) {
	const dir = mkdtempSync(path.join(tmpdir(), "guardrails-"));
	try {
		const src = path.join(dir, "src");
		const repos = [];
		const files = new Map(); // temp path → {repo, file, lines: [{n, text}]}
		for (const c of chunks) {
			let r = repos.indexOf(c.repo);
			if (r === -1) r = repos.push(c.repo) - 1;
			const temp = path.join(src, String(r), c.file);
			if (!files.has(temp)) files.set(temp, { repo: c.repo, file: c.file, lines: [] });
			files.get(temp).lines.push(...c.lines);
		}
		if (!files.size) return [];
		if (timeout <= 0) return "timeout";
		for (const [temp, f] of files) {
			mkdirSync(path.dirname(temp), { recursive: true });
			writeFileSync(temp, f.lines.map((l) => l.text).join("\n"));
		}
		const report = path.join(dir, "report.json");
		const r = spawnSync("gitleaks", ["dir", src, "--no-banner", "--redact", "--report-format", "json", "--report-path", report, "--exit-code", "3"], { encoding: "utf8", timeout, killSignal: "SIGKILL" });
		if (r.error?.code === "ETIMEDOUT") return "timeout";
		if (r.status !== 0 && r.status !== 3) return null;
		const found = existsSync(report) ? JSON.parse(readFileSync(report, "utf8") || "[]") : [];
		return found.map((x) => {
			const f = files.get(path.resolve(src, x.File || ""));
			const real = f?.lines[(x.StartLine || 1) - 1]?.n;
			return { file: f ? f.file : path.relative(src, x.File || ""), repo: f?.repo, line: real ?? x.StartLine, rule: `gitleaks ${x.RuleID}`, sample: "(redacted)" };
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Secret check for a command line: every commit in it, scanned in the repo it runs in.
 * @param {string} line
 * @param {string} cwd where the command starts
 * @param {{gitleaks?: boolean, home?: string, env?: object, budgetMs?: number, now?: () => number, runGit?: Function}} [opts]
 *   env supplies CLAUDE_PROJECT_DIR for `cd $CLAUDE_PROJECT_DIR`; budgetMs (default SCAN_BUDGET_MS), now and runGit
 *   are for tests (the scan budget, the clock, and the git runner for the scan and the alias lookups)
 * @return {null | {decision: "deny" | "ask", reason: string}} deny = a secret would be committed (wins over ask);
 *   ask = a commit's repo can't be determined, an env -S string mentions git (never a guess at the repo), or the scan
 *   ran out of time
 */
export function secretCheck(line, cwd, opts = {}) {
	const budgetMs = opts.budgetMs ?? SCAN_BUDGET_MS;
	const budget = scanBudget(budgetMs, { now: opts.now, runGit: opts.runGit });
	const plans = commitPlans(line, { cwd, home: opts.home, env: opts.env, now: opts.now, runGit: opts.runGit });
	const asks = [];
	const chunks = [];
	for (const p of plans) {
		if (p.unparsable) asks.push(p.unparsable === "env -S" ? ASK_SPLIT : p.unparsable === "xargs" ? ASK_XARGS : ASK_UNPARSED);
		else if (p.dir === null) asks.push(`${ASK_UNRESOLVED} (${capFragment(p.unresolved)})`);
		else {
			try {
				for (const c of contentToCommit(p.dir, p, budget)) chunks.push({ ...c, repo: p.dir });
			} catch (e) {
				if (!(e instanceof ScanTimeout)) throw e;
				asks.push(ASK_TIMEOUT);
			}
		}
	}
	if (chunks.length) {
		let hits = null;
		let how = "built-in patterns";
		const reserve = reserveFor(budgetMs);
		const gitleaks = opts.gitleaks === undefined ? hasGitleaks(Math.min(GITLEAKS_VERSION_MS, budget.left() - reserve)) : opts.gitleaks ? "yes" : "no";
		if (gitleaks === "timeout") how = "built-in patterns (gitleaks timed out)";
		if (gitleaks === "yes") {
			const r = scanGitleaks(chunks, budget.left() - reserve);
			if (r === "timeout") how = "built-in patterns (gitleaks timed out)";
			else if (r === null) how = "built-in patterns (gitleaks failed to run)";
			else {
				hits = r;
				how = "gitleaks";
			}
		}
		if (hits === null) {
			// The built-in patterns run only if there's time left; otherwise this commit isn't checked → ask.
			if (budget.left() <= 0) return { decision: "ask", reason: `guardrails: ${[...new Set([...asks, ASK_TIMEOUT])].join("; ")}.` };
			hits = scanBuiltIn(chunks);
		}
		if (hits.length) {
			const where = (h) => (h.repo && path.resolve(h.repo) !== path.resolve(cwd) ? `${path.relative(cwd, h.repo) || "."}: ` : "");
			const list = hits.slice(0, 20).map((h) => `  ${where(h)}${h.file}:${h.line}  ${h.rule}  ${h.sample}`).join("\n");
			return {
				decision: "deny",
				reason: `guardrails blocked this commit: it would commit what looks like a secret (checked with ${how}).\n${list}${hits.length > 20 ? `\n  …and ${hits.length - 20} more` : ""}\nRemove it (and rotate it if it was real), or opt out with .claude/guardrails.json "secrets": false.`
			};
		}
	}
	return asks.length ? { decision: "ask", reason: `guardrails: ${[...new Set(asks)].join("; ")}.` } : null;
}

// ---- dangerous commands (opt-in) --------------------------------------------------------------------------------

/** `git push` long options that take a value (as the next word, or after "="). */
const PUSH_VALUE_LONG = new Set(["--push-option", "--receive-pack", "--exec", "--repo"]);
/** Every branch, for --all / --mirror / a wildcard refspec / push.default=matching. */
const ALL = "\0all";

/**
 * The parts of `git push` arguments that decide where it pushes. Option values (-o / --push-option, --receive-pack /
 * --exec, --repo, and their attached or "=" forms) are skipped, so the first positional is the repository (it wins
 * over --repo) and the rest are refspecs.
 * @return {{repo: ?string, refspecs: string[], force: boolean, lease: boolean, all: boolean, mirror: boolean, del: boolean, tags: boolean}}
 */
export function parsePush(args) {
	const out = { repo: null, refspecs: [], force: false, lease: false, all: false, mirror: false, del: false, tags: false };
	const pos = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") {
			pos.push(...args.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
			if (PUSH_VALUE_LONG.has(name)) {
				if (!a.includes("=")) i++;
			} else if (name === "--force") out.force = true;
			else if (name === "--force-with-lease") out.lease = true;
			else if (name === "--all" || name === "--branches") out.all = true;
			else if (name === "--mirror") out.mirror = true;
			else if (name === "--delete") out.del = true;
			else if (name === "--tags") out.tags = true;
			continue;
		}
		if (a.length > 1 && a.startsWith("-")) {
			for (let j = 1; j < a.length; j++) {
				if (a[j] === "o") {
					if (j === a.length - 1) i++; // -o VALUE; otherwise the value is attached (-oci.skip)
					break;
				}
				if (a[j] === "f") out.force = true;
				if (a[j] === "d") out.del = true;
			}
			continue;
		}
		pos.push(a);
	}
	out.repo = pos[0] ?? null;
	out.refspecs = pos.slice(1);
	return out;
}

/** A refspec destination as a branch name: refs/heads/x → x; ALL for a wildcard; null for a non-branch ref (tags …). */
function branchOf(dst) {
	if (dst.includes("*")) return ALL;
	if (dst.startsWith("refs/heads/")) return dst.slice("refs/heads/".length);
	if (dst.startsWith("refs/")) return null;
	return dst;
}

/**
 * The branches a `git push` updates: {targets: [{branch, forced, del}], unknown?: reason}. HEAD / @ and a bare push
 * need the repo (the current branch, its upstream, push.default); without it, unknown says why.
 */
export function pushTargets(p, gitDir) {
	const current = () => (gitDir === null ? null : git(gitDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim() || null);
	if (p.mirror || p.all) return { targets: [{ branch: ALL, forced: p.force || p.mirror, del: false, how: p.mirror ? "--mirror" : "--all" }] };
	const targets = [];
	for (const spec of p.refspecs) {
		const forced = p.force || spec.startsWith("+");
		const s = spec.replace(/^\+/, "");
		const colon = s.indexOf(":");
		const del = p.del || (colon === 0);
		let dst = p.del ? s : colon === -1 ? s : s.slice(colon + 1);
		if (!dst) continue;
		if (dst === "HEAD" || dst === "@") {
			if (gitDir === null) return { targets, unknown: `git push ${spec} (HEAD in a folder that can't be determined)` };
			dst = current();
			if (!dst) continue; // detached HEAD: not a branch
		}
		const branch = branchOf(dst);
		if (branch !== null) targets.push({ branch, forced, del });
	}
	if (p.refspecs.length || p.tags) return { targets };
	// A bare push (or `git push <remote>`): the current branch, and the branch its upstream points at.
	if (gitDir === null) return { targets, unknown: "git push with no branch named, in a folder that can't be determined" };
	if (git(gitDir, ["config", "--get", "push.default"]).trim() === "matching") return { targets: [{ branch: ALL, forced: p.force, del: false, how: "push.default=matching" }] };
	const cur = current();
	if (cur) {
		targets.push({ branch: cur, forced: p.force, del: false });
		const merge = git(gitDir, ["config", "--get", `branch.${cur}.merge`]).trim();
		const up = merge ? branchOf(merge) : null;
		if (up && up !== cur) targets.push({ branch: up, forced: p.force, del: false, how: `the upstream of ${cur}` });
	}
	return { targets };
}

/** gh options that take a value, wherever they appear (global -R / --repo, and gh api's). */
const GH_VALUE = { short: "RXHfFqtp", long: new Set(["--repo", "--method", "--header", "--field", "--raw-field", "--jq", "--template", "--input", "--hostname", "--cache", "--preview"]) };

/** A block reason for a `gh` command that merges a PR, else null. */
export function ghMergeReason(words) {
	if (words[0] !== "gh") return null;
	const pos = [];
	for (let i = 1; i < words.length; i++) {
		const a = words[i];
		if (a === "--") {
			pos.push(...words.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			if (GH_VALUE.long.has(a)) i++;
		} else if (a.length > 1 && a.startsWith("-")) {
			if (a.length === 2 && GH_VALUE.short.includes(a[1])) i++;
		} else pos.push(a);
	}
	if (pos[0] === "pr" && pos[1] === "merge") return "gh pr merge";
	if (pos[0] !== "api") return null;
	const endpoint = pos[1] ?? "";
	if (/(^|\/)repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge(?:[/?]|$)/.test(endpoint)) return `gh api ${capFragment(endpoint, 50)} (merges a pull request)`;
	if (endpoint === "graphql") {
		const m = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/.exec(words.join(" "));
		if (m) return `gh api graphql ${m[1]}`;
	}
	return null;
}

/** How deep `bash -c '…'` strings are followed for the dangerous-command checks. */
const DANGER_NEST = 3;

/**
 * The dangerous-command checks for a command line: {block: string[], ask: string[]}. Each command is normalised
 * (env / command / sudo with its options, "\rm", /bin/rm …) and runs in the directory the shell would be in (cd,
 * pushd, env -C …). `bash|sh|zsh|dash|ksh -c '…'` strings are checked as command lines of their own (3 deep).
 * block: merges and pushes a person should do (see the header). ask: destructive local commands. When a directory
 * can't be determined, a relative rm target isn't judged and a push whose branch depends on the repo asks.
 */
export function dangerChecks(line, cwd, projectDir, depth = 0, why = null) {
	const block = [];
	const ask = [];
	const home = homedir();
	const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
	for (const s of trackCommands(line, { cwd, why, home, env })) {
		const inner = SHELLS.has(s.words[0]) ? shellCommandString(s.words) : null;
		if (inner !== null) {
			if (depth + 1 <= DANGER_NEST) {
				const r = dangerChecks(inner, s.dir, projectDir, depth + 1, s.why);
				block.push(...r.block);
				ask.push(...r.ask);
			}
			continue;
		}
		const gh = ghMergeReason(s.words);
		if (gh) {
			block.push(gh);
			continue;
		}
		const g = parseGit(s.words);
		if (g) {
			const flags = g.args.filter((a) => a.startsWith("-"));
			const rest = g.args.filter((a) => !a.startsWith("-"));
			if (g.sub === "push") {
				let gitDir = g.other ? null : s.dir;
				for (const c of g.chdirs) gitDir = gitDir === null ? null : resolveDir(c, gitDir, { home, env }).dir ?? null;
				const p = parsePush(g.args);
				const { targets, unknown } = pushTargets(p, gitDir);
				const def = gitDir === null ? null : defaultBranch(gitDir);
				const protectedBranches = def ? [def] : ["main", "master"];
				const name = protectedBranches.join(" / ");
				for (const t of targets) {
					if (t.branch === ALL) block.push(`${t.forced ? "force-" : ""}push to every branch (${t.how}), including the default branch (${name})`);
					else if (protectedBranches.includes(t.branch)) {
						const via = t.how ? ` (${t.how})` : "";
						block.push(t.del ? `delete the default branch (${t.branch})` : `${t.forced ? "force-push" : "push"} to the default branch (${t.branch})${via}`);
					} else if (t.forced && !t.del) block.push(`force-push to ${t.branch} (only --force-with-lease is allowed on other branches)`);
				}
				if (unknown) ask.push(`can't tell which branch this pushes to: ${capFragment(unknown)}`);
			}
			if (g.sub === "reset" && flags.includes("--hard")) ask.push("git reset --hard discards uncommitted work");
			if (g.sub === "clean") {
				const letters = flags.filter((f) => /^-[a-zA-Z]+$/.test(f)).join("");
				const force = /f/.test(letters) || flags.includes("--force");
				const dirs = /d/.test(letters);
				if (force && dirs) ask.push(`git clean ${flags.join(" ")} deletes untracked files and folders`);
			}
			if (g.sub === "checkout" && rest.includes(".")) ask.push("git checkout -- . discards uncommitted changes");
			if (g.sub === "restore" && rest.includes(".") && !(flags.includes("--staged") && !flags.includes("--worktree") && !flags.includes("-W"))) {
				ask.push("git restore . discards uncommitted changes");
			}
			continue;
		}
		const w = s.words;
		if (w[0] !== "rm") continue;
		const opts = w.slice(1).filter((a) => a.startsWith("-"));
		const letters = opts.filter((o) => /^-[a-zA-Z]+$/.test(o)).join("");
		const recursive = /[rR]/.test(letters) || opts.includes("--recursive");
		const force = /f/.test(letters) || opts.includes("--force");
		if (!recursive || !force) continue;
		for (const t of w.slice(1).filter((a) => !a.startsWith("-"))) {
			const bare = t.replace(/\/\*?$/, "") || "/";
			const expanded = bare.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?/, home).replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, projectDir);
			if (t !== "*" && !path.isAbsolute(expanded) && s.dir === null) continue; // relative to a directory we can't determine
			const abs = path.resolve(s.dir ?? "/", expanded);
			if (t === "*" || abs === "/" || abs === home || abs === path.resolve(projectDir)) {
				ask.push(`rm -rf ${t} would delete ${abs === "/" ? "the whole disk" : abs === home ? "your home folder" : "the whole repo"}`);
			}
		}
	}
	return { block: [...new Set(block)], ask: [...new Set(ask)] };
}

/** The reason shown when a dangerous command is blocked. */
export const blockReason = (block) =>
	`guardrails blocked this: ${block.join("; ")}. Merging a pull request or pushing to the default branch is for a person to do, and force-pushing other branches needs --force-with-lease. (Opt out with .claude/guardrails.json "dangerousCommands": false.)`;

/** The whole hook, as data. */
export function preBash(input, env = process.env, opts = {}) {
	const projectDir = projectDirOf(input, env);
	const cfg = loadConfig(projectDir, env);
	const line = String(input?.tool_input?.command || "");
	const cwd = input.cwd || projectDir;
	const note = cfg.warning ? { systemMessage: cfg.warning } : {};
	if (!line) return { exit: 0, json: cfg.warning ? note : undefined };
	const asks = [];
	if (cfg.on.secrets) {
		const r = secretCheck(line, cwd, { ...opts, env: { ...env, CLAUDE_PROJECT_DIR: projectDir } });
		if (r?.decision === "deny") return { exit: 0, json: { ...note, ...decision("deny", r.reason) } };
		if (r) asks.push(r.reason);
	}
	if (cfg.on.dangerous) {
		const d = dangerChecks(line, cwd, projectDir);
		if (d.block.length) return { exit: 0, json: { ...note, ...decision("deny", blockReason(d.block)) } };
		if (d.ask.length) asks.push(`guardrails: ${d.ask.join("; ")}.`);
	}
	if (asks.length) return { exit: 0, json: { ...note, ...decision("ask", `${asks.join(" ")} Run it anyway?`) } };
	return { exit: 0, json: cfg.warning ? note : undefined };
}

if (isMain(process.argv[1], import.meta.url)) finish(preBash(await readInput()));
