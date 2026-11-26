#!/usr/bin/env node
// privacy PreToolUse hook on Bash (opt-in: .claude/privacy.json "commitHook": true). Before each `git commit`
// in the command, scans what it will commit (index; tracked changes for -a/--all; paths a chained `git add`
// stages) for personal data, in the repo it runs in (following cd, pushd, env -C, sudo -D, git -C and wrappers
// like env / command / sudo). A match → deny, values hidden. If the repo can't be determined, or an env -S
// string mentions git → "ask". No network: a URL denylist is read from its local cache (`/privacy-scan refresh`).
// Hook format: https://code.claude.com/docs/en/hooks
import path from "node:path";
import { capFragment, commitPlans, contentToCommit } from "./commit-content.mjs";

export { capFragment } from "./commit-content.mjs";
import { formatFindings, loadDenylist, loadPrivacyConfig, scanChunks } from "./detectors.mjs";
import { isMain } from "./is-main.mjs";

/** Why the commit hook asks instead of scanning. */
export const ASK_UNRESOLVED = "can't tell which repo this commits in; personal data not checked";
export const ASK_SPLIT = "can't parse env -S; personal data not checked";
export const ASK_UNPARSED = "can't parse this commit; personal data not checked";
export const ASK_XARGS = "can't see xargs arguments; personal data not checked";

/** The whole hook, as data: {exit, json?}. The session project's config and denylist apply to every commit. */
export function privacyPreBash(input, env = process.env) {
	const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
	const cfg = loadPrivacyConfig(projectDir);
	const warn = cfg.warning ? [cfg.warning] : [];
	const line = String(input?.tool_input?.command || "");
	const cwd = input.cwd || projectDir;
	const plans = cfg.commitHook && line ? commitPlans(line, { cwd, env: { ...env, CLAUDE_PROJECT_DIR: projectDir } }) : [];
	if (!plans.length) return { exit: 0, json: warn.length ? { systemMessage: warn.join("\n") } : undefined };
	const asks = [];
	const chunks = [];
	for (const p of plans) {
		if (p.unparsable) asks.push(p.unparsable === "env -S" ? ASK_SPLIT : p.unparsable === "xargs" ? ASK_XARGS : ASK_UNPARSED);
		else if (p.dir === null) asks.push(`${ASK_UNRESOLVED} (${capFragment(p.unresolved)})`);
		else {
			const where = path.resolve(p.dir) === path.resolve(cwd) ? "" : `${path.relative(cwd, p.dir) || "."}: `;
			for (const c of contentToCommit(p.dir, p)) chunks.push({ ...c, file: `${where}${c.file}` });
		}
	}
	const { entries, notes } = loadDenylist(projectDir, cfg);
	const findings = scanChunks(chunks, cfg, entries);
	const extra = warn.concat(notes);
	if (findings.length) {
		const reason = `privacy blocked this commit: it would commit what looks like personal data (values hidden).\n${formatFindings(findings)}` +
			`${extra.length ? `\n${extra.map((n) => `(${n})`).join("\n")}` : ""}\nRemove or replace it with made-up data, or allowlist it in .claude/privacy.json.`;
		return { exit: 0, json: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } };
	}
	if (asks.length) {
		const reason = `privacy: ${[...new Set(asks)].join("; ")}.${extra.length ? ` (${extra.join("; ")})` : ""}`;
		return { exit: 0, json: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } } };
	}
	return { exit: 0, json: extra.length ? { systemMessage: `privacy: ${extra.join("; ")}` } : undefined };
}

async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	let input = {};
	try {
		input = JSON.parse(raw || "{}");
	} catch {
		/* not hook input */
	}
	const r = privacyPreBash(input);
	if (r.json) process.stdout.write(`${JSON.stringify(r.json)}\n`);
	process.exitCode = r.exit; // not process.exit(): let stdout finish writing on a pipe
}

if (isMain(process.argv[1], import.meta.url)) await main();
