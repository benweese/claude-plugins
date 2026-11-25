#!/usr/bin/env node
// workflow SessionStart hook (opt-in): adds the project's working rules to Claude's context.
// On only when .claude/workflow.json is valid JSON with "version": 1 and "principles": true. Other keys are
// ignored (later features add their own). Missing file, or "principles" false/absent → silent.
// Present but invalid (unreadable, bad JSON, not an object, wrong version, "principles" not a boolean)
// → a systemMessage warning shown to the user, nothing added to context.
// Plain stdout becomes context; a lone JSON object is read as hook output: https://code.claude.com/docs/en/hooks
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HEADER = "Working rules for this project (workflow plugin, .claude/workflow.json):";

export const RULES = [
	"Verify before saying done.",
	"Never invent paths, output or test results.",
	"Say when a premise looks wrong before building around it.",
	"Touch only what the task needs.",
	"If a check fails, fix the cause; never weaken or skip the check.",
	"Ask, don't assume.",
	"If known gates remain, stop and report the blockers before opening a PR.",
	"Open draft PRs only when asked."
];

/** The text added to Claude's context when the rules are on. */
export const rulesText = () => [HEADER, ...RULES.map((r, i) => `${i + 1}. ${r}`)].join("\n");

/**
 * Reads <projectDir>/.claude/workflow.json.
 * @return {{state: "missing"} | {state: "invalid", reason: string} | {state: "ok", principles: boolean}}
 */
export function readConfig(projectDir) {
	let raw;
	try {
		raw = readFileSync(path.join(projectDir, ".claude", "workflow.json"), "utf8");
	} catch (e) {
		if (e.code === "ENOENT") return { state: "missing" };
		return { state: "invalid", reason: `can't be read: ${e.code || e.message}` };
	}
	let c;
	try {
		c = JSON.parse(raw.replace(/^﻿/, ""));
	} catch {
		return { state: "invalid", reason: "not valid JSON" };
	}
	if (!c || typeof c !== "object" || Array.isArray(c)) return { state: "invalid", reason: "not a JSON object" };
	if (c.version !== 1) return { state: "invalid", reason: 'needs "version": 1' };
	if (c.principles !== undefined && typeof c.principles !== "boolean") {
		return { state: "invalid", reason: "principles must be true or false" };
	}
	return { state: "ok", principles: c.principles === true };
}

/** The project root: CLAUDE_PROJECT_DIR, else the hook's cwd, else this process's cwd. */
export const projectDirOf = (input, env = process.env) => env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();

/** The whole hook, as data: what to print on stdout ("" = nothing). Always exits 0. */
export function principles(input, env = process.env) {
	const cfg = readConfig(projectDirOf(input, env));
	if (cfg.state === "invalid") {
		return { stdout: JSON.stringify({ systemMessage: `workflow: .claude/workflow.json is invalid (${cfg.reason}), session rules are off` }) };
	}
	if (cfg.state === "ok" && cfg.principles) return { stdout: rulesText() };
	return { stdout: "" };
}

/** Reads the hook's JSON from stdin ({} if empty or not JSON). */
async function readInput() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	try {
		return JSON.parse(raw || "{}");
	} catch {
		return {};
	}
}

/** True when run as a script, even through a symlinked path (argv[1] isn't resolved; import.meta.url is). */
export function isMain(argv1 = process.argv[1], selfUrl = import.meta.url) {
	if (!argv1) return false;
	try {
		return realpathSync(argv1) === realpathSync(fileURLToPath(selfUrl));
	} catch {
		return false;
	}
}

if (isMain()) {
	const { stdout } = principles(await readInput());
	if (stdout) process.stdout.write(`${stdout}\n`);
	process.exitCode = 0; // no process.exit(): let stdout drain on async pipes
}
