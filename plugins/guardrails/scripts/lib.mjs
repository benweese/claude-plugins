// Shared pieces for the guardrails hooks: config, hook I/O, globs, shell splitting, git helpers.
// Hook input/output format: https://code.claude.com/docs/en/hooks
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const FEATURES = ["secrets", "lint", "protected", "dangerous"];
export const DEFAULT_PROTECTED = [".env*", "*.pem", "*.key", "id_*", "credentials*"];
export const DEFAULT_ALLOW = [".env.example", ".env.sample", ".env.template"];

/**
 * The project's guardrails settings. `.claude/guardrails.json` must be valid JSON with "version": 1.
 * Missing → the secret blocker on, everything else off. Invalid → the same, plus a warning (the secret
 * blocker stays on: the safe direction). BENWEESE_GUARDRAILS_OFF="lint,secrets,protected,dangerous" turns
 * features off from the environment.
 * @return {{on: Record<string, boolean>, protected: string[], allow: string[], lintCommand: ?string, warning: ?string}}
 */
export function loadConfig(projectDir, env = process.env) {
	const out = { on: { secrets: true, lint: false, protected: false, dangerous: false }, protected: DEFAULT_PROTECTED, allow: DEFAULT_ALLOW, lintCommand: null, warning: null };
	const file = path.join(projectDir, ".claude", "guardrails.json");
	let raw = null;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		/* no config: defaults */
	}
	if (raw !== null) {
		let c;
		try {
			c = JSON.parse(raw);
		} catch {
			c = null;
		}
		if (!c || typeof c !== "object" || c.version !== 1) {
			out.warning = "guardrails: .claude/guardrails.json is invalid (needs valid JSON with \"version\": 1) — only the secret blocker is on";
		} else {
			out.on.secrets = c.secrets !== false;
			out.on.lint = c.lint === true;
			out.on.protected = c.protectedFiles === true;
			out.on.dangerous = c.dangerousCommands === true;
			if (Array.isArray(c.protected)) out.protected = c.protected.filter((g) => typeof g === "string");
			if (Array.isArray(c.allow)) out.allow = c.allow.filter((g) => typeof g === "string");
			if (typeof c.lintCommand === "string" && c.lintCommand.trim()) out.lintCommand = c.lintCommand;
		}
	}
	for (const f of String(env.BENWEESE_GUARDRAILS_OFF || "").split(/[,\s]+/).filter(Boolean)) if (f in out.on) out.on[f] = false;
	return out;
}

/** Reads the hook's JSON from stdin ({} if empty or not JSON). */
export async function readInput() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	try {
		return JSON.parse(raw || "{}");
	} catch {
		return {};
	}
}

/** The project root: CLAUDE_PROJECT_DIR, else the hook's cwd. */
export const projectDirOf = (input, env = process.env) => env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

/** Prints a hook result and exits. r: {exit, stderr?, json?}. */
export function finish(r) {
	if (r.stderr) process.stderr.write(`${r.stderr}\n`);
	if (r.json) process.stdout.write(`${JSON.stringify(r.json)}\n`);
	process.exit(r.exit || 0);
}

/** A PreToolUse decision ("deny" | "ask") with a reason, as hook JSON. */
export const decision = (permissionDecision, reason) => ({
	hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason }
});

/** A glob ("*" = anything but "/", "?" = one char) as an anchored regex. */
export function globToRegex(glob) {
	const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
	return new RegExp(`^${body}$`);
}

/** Does the path match any glob, by its file name or its path relative to the project? */
export function matchesAny(filePath, globs, projectDir) {
	const base = path.basename(filePath);
	const rel = path.relative(projectDir, path.resolve(projectDir, filePath)).split(path.sep).join("/");
	return globs.some((g) => {
		const re = globToRegex(g);
		return re.test(base) || re.test(rel);
	});
}

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

/** The repo's default branch: origin/HEAD, else init.defaultBranch, else null (unknown). */
export function defaultBranch(cwd) {
	const head = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
	if (head) return head.replace(/^[^/]+\//, "");
	const init = git(cwd, ["config", "--get", "init.defaultBranch"]).trim();
	return init || null;
}
