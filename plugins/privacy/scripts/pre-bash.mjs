#!/usr/bin/env node
// privacy PreToolUse hook on Bash (opt-in: .claude/privacy.json "commitHook": true). Before Claude runs
// `git commit`, scans what will be committed (index; tracked changes for -a/--all; paths a chained
// `git add` stages) for personal data. A match → deny, values hidden. No network: a URL denylist is read
// from its local cache (`/privacy-scan refresh`). Hook format: https://code.claude.com/docs/en/hooks
import { fileURLToPath } from "node:url";
import { commitPlan, contentToCommit } from "./commit-content.mjs";
import { formatFindings, loadDenylist, loadPrivacyConfig, scanChunks } from "./detectors.mjs";

/** The whole hook, as data: {exit, json?}. */
export function privacyPreBash(input, env = process.env) {
	const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
	const cfg = loadPrivacyConfig(projectDir);
	const warn = cfg.warning ? [cfg.warning] : [];
	const line = String(input?.tool_input?.command || "");
	const plan = cfg.commitHook && line ? commitPlan(line) : { commit: false };
	if (!plan.commit) return { exit: 0, json: warn.length ? { systemMessage: warn.join("\n") } : undefined };
	const chunks = contentToCommit(input.cwd || projectDir, plan);
	const { entries, notes } = loadDenylist(projectDir, cfg);
	const findings = scanChunks(chunks, cfg, entries);
	const extra = warn.concat(notes);
	if (findings.length) {
		const reason = `privacy blocked this commit: it would commit what looks like personal data (values hidden).\n${formatFindings(findings)}` +
			`${extra.length ? `\n${extra.map((n) => `(${n})`).join("\n")}` : ""}\nRemove or replace it with made-up data, or allowlist it in .claude/privacy.json.`;
		return { exit: 0, json: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } };
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
	process.exit(r.exit);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
