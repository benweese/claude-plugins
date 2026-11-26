#!/usr/bin/env node
// guardrails PreToolUse hook on Edit | Write | MultiEdit | Read (opt-in, "protectedFiles": true):
// blocks touching files like .env*, *.pem, *.key, id_*, credentials* — reading one would put the secret
// into the conversation. .env.example / .env.sample / .env.template are allowed. Both lists are
// configurable ("protected", "allow" in .claude/guardrails.json). Shell commands (cat .env) aren't parsed.
import { decision, finish, loadConfig, matchesAny, projectDirOf, readInput } from "./lib.mjs";
import { isMain } from "./is-main.mjs";

/** The whole hook, as data. */
export function protectedFiles(input, env = process.env) {
	const projectDir = projectDirOf(input, env);
	const cfg = loadConfig(projectDir, env);
	const note = cfg.warning ? { systemMessage: cfg.warning } : undefined;
	const file = input?.tool_input?.file_path;
	if (!cfg.on.protected || !file) return { exit: 0, json: note };
	if (matchesAny(file, cfg.allow, projectDir) || !matchesAny(file, cfg.protected, projectDir)) return { exit: 0, json: note };
	const verb = input.tool_name === "Read" ? "read" : "change";
	return {
		exit: 0,
		json: { ...(note || {}), ...decision("deny", `guardrails: ${file} is a protected file (secrets live there), so Claude won't ${verb} it. Edit it yourself, or change "protected" / "allow" in .claude/guardrails.json.`) }
	};
}

if (isMain(process.argv[1], import.meta.url)) finish(protectedFiles(await readInput()));
