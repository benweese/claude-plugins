#!/usr/bin/env node
// guardrails PreToolUse hook on Bash:
//  - secrets (ON by default): before each `git commit` in the command, scan what it will commit — the index,
//    plus tracked changes for -a/--all, plus paths a chained `git add …` stages — in the repo it runs in
//    (following cd, pushd, env -C, sudo -D, git -C and wrappers like env / command / sudo), with gitleaks if
//    installed, else built-in patterns. A match → deny (the commit doesn't run), secrets masked. If the repo
//    can't be determined (cd "$X", cd -, popd, a missing folder …) or an env -S string mentions git → "ask".
//  - dangerous (opt-in): force-push to the default branch, reset --hard, clean -fd, checkout -- ., restore .,
//    rm -rf on / ~ $HOME or the repo root → "ask" (the normal permission prompt, with the reason).
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { decision, defaultBranch, finish, git, loadConfig, projectDirOf, readInput } from "./lib.mjs";
import { isMain } from "./is-main.mjs";
import { capFragment, commitPlans, contentToCommit, parseGit, resolveDir, trackCommands } from "./commit-content.mjs";

export { capFragment, commitPlans, addedLines, contentToCommit } from "./commit-content.mjs";

/** Why the secret check asks instead of scanning. */
export const ASK_UNRESOLVED = "can't tell which repo this commits in; secrets not checked";
export const ASK_SPLIT = "can't parse env -S; secrets not checked";
export const ASK_UNPARSED = "can't parse this commit; secrets not checked";

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

/** gitleaks on PATH? */
function hasGitleaks() {
	return spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0;
}

/**
 * gitleaks scan of the chunks. Each file's added lines are written to a temp file (one folder per repo), and every
 * finding's StartLine — a line in that temp file — is mapped back to the real line number. Returns hits, or null if
 * gitleaks failed.
 */
function scanGitleaks(chunks) {
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
		for (const [temp, f] of files) {
			mkdirSync(path.dirname(temp), { recursive: true });
			writeFileSync(temp, f.lines.map((l) => l.text).join("\n"));
		}
		const report = path.join(dir, "report.json");
		const r = spawnSync("gitleaks", ["dir", src, "--no-banner", "--redact", "--report-format", "json", "--report-path", report, "--exit-code", "3"], { encoding: "utf8" });
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
 * @param {{gitleaks?: boolean, home?: string, env?: object}} [opts] env supplies CLAUDE_PROJECT_DIR for `cd $CLAUDE_PROJECT_DIR`
 * @return {null | {decision: "deny" | "ask", reason: string}} deny = a secret would be committed (wins over ask);
 *   ask = a commit's repo can't be determined, or an env -S string mentions git (never a guess at the repo)
 */
export function secretCheck(line, cwd, opts = {}) {
	const plans = commitPlans(line, { cwd, home: opts.home, env: opts.env });
	const asks = [];
	const chunks = [];
	for (const p of plans) {
		if (p.unparsable) asks.push(p.unparsable === "env -S" ? ASK_SPLIT : ASK_UNPARSED);
		else if (p.dir === null) asks.push(`${ASK_UNRESOLVED} (${capFragment(p.unresolved)})`);
		else for (const c of contentToCommit(p.dir, p)) chunks.push({ ...c, repo: p.dir });
	}
	if (chunks.length) {
		let hits = null;
		let how = "built-in patterns";
		if (opts.gitleaks ?? hasGitleaks()) {
			hits = scanGitleaks(chunks);
			how = hits === null ? "built-in patterns (gitleaks failed to run)" : "gitleaks";
		}
		if (hits === null) hits = scanBuiltIn(chunks);
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

/**
 * Reasons a command line is dangerous ([] if none). Each command is normalised (env / command / sudo with its options,
 * "\rm", /bin/rm …) and runs in the directory the shell would be in (cd, pushd, env -C …). When that directory
 * can't be determined, a relative rm target isn't judged (no guessing); absolute, ~ and $HOME targets still are.
 */
export function dangerReasons(line, cwd, projectDir) {
	const reasons = [];
	const home = homedir();
	const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
	for (const s of trackCommands(line, { cwd, home, env })) {
		const g = parseGit(s.words);
		if (g) {
			const flags = g.args.filter((a) => a.startsWith("-"));
			const rest = g.args.filter((a) => !a.startsWith("-"));
			if (g.sub === "push") {
				const forced = flags.some((f) => f === "--force" || f === "-f" || f.startsWith("--force-with-lease") || /^-[a-z]*f[a-z]*$/.test(f)) || rest.some((r) => r.startsWith("+"));
				let gitDir = s.dir;
				for (const c of g.chdirs) gitDir = resolveDir(c, gitDir, { home, env }).dir ?? null;
				if (forced && gitDir !== null) {
					const refspecs = rest.slice(1);
					const targets = (refspecs.length ? refspecs : [git(gitDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()])
						.map((r) => r.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, ""));
					const def = defaultBranch(gitDir);
					const protectedBranches = def ? [def] : ["main", "master"];
					const hit = targets.find((t) => protectedBranches.includes(t));
					if (hit) reasons.push(`force-push to the default branch (${hit})`);
				}
			}
			if (g.sub === "reset" && flags.includes("--hard")) reasons.push("git reset --hard discards uncommitted work");
			if (g.sub === "clean") {
				const letters = flags.filter((f) => /^-[a-zA-Z]+$/.test(f)).join("");
				const force = /f/.test(letters) || flags.includes("--force");
				const dirs = /d/.test(letters);
				if (force && dirs) reasons.push(`git clean ${flags.join(" ")} deletes untracked files and folders`);
			}
			if (g.sub === "checkout" && rest.includes(".")) reasons.push("git checkout -- . discards uncommitted changes");
			if (g.sub === "restore" && rest.includes(".") && !(flags.includes("--staged") && !flags.includes("--worktree") && !flags.includes("-W"))) {
				reasons.push("git restore . discards uncommitted changes");
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
				reasons.push(`rm -rf ${t} would delete ${abs === "/" ? "the whole disk" : abs === home ? "your home folder" : "the whole repo"}`);
			}
		}
	}
	return reasons;
}

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
		const reasons = dangerReasons(line, cwd, projectDir);
		if (reasons.length) asks.push(`guardrails: ${reasons.join("; ")}.`);
	}
	if (asks.length) return { exit: 0, json: { ...note, ...decision("ask", `${asks.join(" ")} Run it anyway?`) } };
	return { exit: 0, json: cfg.warning ? note : undefined };
}

if (isMain(process.argv[1], import.meta.url)) finish(preBash(await readInput()));
