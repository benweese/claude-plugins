#!/usr/bin/env node
// guardrails PreToolUse hook on Bash:
//  - secrets (ON by default): before `git commit`, scan what will be committed — the index, plus tracked
//    changes for -a/--all, plus paths a chained `git add …` stages — with gitleaks if installed, else
//    built-in patterns. A match → deny (the commit doesn't run), secrets masked.
//  - dangerous (opt-in): force-push to the default branch, reset --hard, clean -fd, checkout -- ., restore .,
//    rm -rf on / ~ $HOME or the repo root → "ask" (the normal permission prompt, with the reason).
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decision, defaultBranch, finish, git, gitSub, loadConfig, projectDirOf, readInput, splitCommands, words } from "./lib.mjs";

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

/** What a command line will commit: {commit, all, addAll, addPaths, addTracked}. */
export function commitPlan(line) {
	const plan = { commit: false, all: false, addAll: false, addTracked: false, addPaths: [] };
	for (const seg of splitCommands(line)) {
		const g = gitSub(seg);
		if (!g) continue;
		if (g.sub === "add") {
			for (const a of g.args) {
				if (a === "-A" || a === "--all" || a === ".") plan.addAll = true;
				else if (a === "-u" || a === "--update") plan.addTracked = true;
				else if (!a.startsWith("-")) plan.addPaths.push(a);
			}
		}
		if (g.sub === "commit") {
			plan.commit = true;
			for (const a of g.args) if (a === "--all" || /^-[A-Za-z]*a[A-Za-z]*$/.test(a)) plan.all = true;
			break; // later segments run after the commit
		}
	}
	return plan;
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

/** Built-in scan: [{file, line, rule, sample}]. */
export function scanBuiltIn(chunks) {
	const hits = [];
	for (const c of chunks) {
		for (const l of c.lines) {
			for (const p of SECRET_PATTERNS) {
				const m = p.re.exec(l.text);
				if (m) hits.push({ file: c.file, line: l.n, rule: p.name, sample: mask(m[0]) });
			}
		}
	}
	return hits;
}

/** gitleaks on PATH? */
function hasGitleaks() {
	return spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0;
}

/** gitleaks scan of the chunks (written to a temp folder). Returns hits, or null if gitleaks failed. */
function scanGitleaks(chunks) {
	const dir = mkdtempSync(path.join(tmpdir(), "guardrails-"));
	try {
		const src = path.join(dir, "src");
		for (const c of chunks) {
			const f = path.join(src, c.file);
			mkdirSync(path.dirname(f), { recursive: true });
			writeFileSync(f, c.lines.map((l) => l.text).join("\n"), { flag: "a" });
		}
		if (!existsSync(src)) return [];
		const report = path.join(dir, "report.json");
		const r = spawnSync("gitleaks", ["dir", src, "--no-banner", "--redact", "--report-format", "json", "--report-path", report, "--exit-code", "3"], { encoding: "utf8" });
		if (r.status !== 0 && r.status !== 3) return null;
		const found = existsSync(report) ? JSON.parse(readFileSync(report, "utf8") || "[]") : [];
		return found.map((f) => ({ file: path.relative(src, f.File || ""), line: f.StartLine, rule: `gitleaks ${f.RuleID}`, sample: "(redacted)" }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Secret check for a command line. Returns a deny reason, or null. */
export function secretCheck(line, repo, opts = {}) {
	const plan = commitPlan(line);
	if (!plan.commit) return null;
	const chunks = contentToCommit(repo, plan);
	if (!chunks.length) return null;
	let hits = null;
	let how = "built-in patterns";
	if (opts.gitleaks ?? hasGitleaks()) {
		hits = scanGitleaks(chunks);
		how = hits === null ? "built-in patterns (gitleaks failed to run)" : "gitleaks";
	}
	if (hits === null) hits = scanBuiltIn(chunks);
	if (!hits.length) return null;
	const list = hits.slice(0, 20).map((h) => `  ${h.file}:${h.line}  ${h.rule}  ${h.sample}`).join("\n");
	return `guardrails blocked this commit: it would commit what looks like a secret (checked with ${how}).\n${list}${hits.length > 20 ? `\n  …and ${hits.length - 20} more` : ""}\nRemove it (and rotate it if it was real), or opt out with .claude/guardrails.json "secrets": false.`;
}

/** Reasons a command line is dangerous ([] if none). */
export function dangerReasons(line, cwd, projectDir) {
	const reasons = [];
	const home = homedir();
	for (const seg of splitCommands(line)) {
		const cdTo = /^cd\s+(\S+)\s*$/.exec(seg); // follow `cd dir && …` so relative targets resolve correctly
		if (cdTo) {
			cwd = path.resolve(cwd, cdTo[1].replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, home));
			continue;
		}
		const g = gitSub(seg);
		if (g) {
			const flags = g.args.filter((a) => a.startsWith("-"));
			const rest = g.args.filter((a) => !a.startsWith("-"));
			if (g.sub === "push") {
				const forced = flags.some((f) => f === "--force" || f === "-f" || f.startsWith("--force-with-lease") || /^-[a-z]*f[a-z]*$/.test(f)) || rest.some((r) => r.startsWith("+"));
				if (forced) {
					const refspecs = rest.slice(1);
					const targets = (refspecs.length ? refspecs : [git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()])
						.map((r) => r.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, ""));
					const def = defaultBranch(cwd);
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
		const w = words(seg);
		const i = w[0] === "sudo" ? 1 : 0;
		if (w[i] !== "rm") continue;
		const opts = w.slice(i + 1).filter((a) => a.startsWith("-"));
		const letters = opts.filter((o) => /^-[a-zA-Z]+$/.test(o)).join("");
		const recursive = /[rR]/.test(letters) || opts.includes("--recursive");
		const force = /f/.test(letters) || opts.includes("--force");
		if (!recursive || !force) continue;
		for (const t of w.slice(i + 1).filter((a) => !a.startsWith("-"))) {
			const bare = t.replace(/\/\*?$/, "") || "/";
			const expanded = bare.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?/, home).replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, projectDir);
			const abs = path.resolve(cwd, expanded);
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
	if (cfg.on.secrets) {
		const reason = secretCheck(line, cwd, opts);
		if (reason) return { exit: 0, json: { ...note, ...decision("deny", reason) } };
	}
	if (cfg.on.dangerous) {
		const reasons = dangerReasons(line, cwd, projectDir);
		if (reasons.length) return { exit: 0, json: { ...note, ...decision("ask", `guardrails: ${reasons.join("; ")}. Run it anyway?`) } };
	}
	return { exit: 0, json: cfg.warning ? note : undefined };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) finish(preBash(await readInput()));
