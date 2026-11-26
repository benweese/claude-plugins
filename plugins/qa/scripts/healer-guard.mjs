#!/usr/bin/env node
// qa hook (PreToolUse on Edit | Write | MultiEdit): the healer never heals an expect.
//
// Opt-in per project: does nothing unless .claude/qa.json is { "version": 1, "hooks": { "healerGuard": true } }.
// A missing or invalid config = off. It only guards the healer: hook input `agent_type` is `ui-test-healer` or
// `<anything>:ui-test-healer` (a plugin agent's type is plugin-scoped, e.g. `qa:ui-test-healer`; it's also set on
// the main thread of a session started with `claude --agent qa:ui-test-healer`). Every other agent, and the main
// session, edits freely.
//
// While guarding, it blocks (exit 2, reason on stderr back to the healer):
//   - in a *.spec.* / *.test.* file: an edit that adds, removes or changes a line containing `expect(`,
//     `expect.soft(`, `expect.poll(` or `expect.configure(`, or a snapshot matcher line (its snapshot name). Edit / MultiEdit are applied to the file on
//     disk and the whole file is compared, so an old_string that's a fragment of an expect line still counts
//     (without the file, old_string vs new_string); Write: the new content vs the file on disk. Lines are compared
//     trimmed, so re-indenting or moving one is fine.
//   - any edit to a file matching .claude/qa.json "expectedData" (globs relative to the project, ** allowed).
// Locator, wait, navigation and setup lines, and adding `test.fixme("<question>")`, pass.
// Hook input/output: https://code.claude.com/docs/en/hooks
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isMain } from "./is-main.mjs";

/** Test files the expect rule applies to. */
export const GUARDED_FILE = /\.(spec|test)\.[^./\\]+$/;
/** Lines the healer may not add, remove or change: an expect call (expect, .soft, .poll, .configure) or a snapshot
 *  matcher (its name). */
export const GUARDED_LINE = /(?<![\w$])expect(?:\.(?:soft|poll|configure))?\s*\(|\.(?:toHaveScreenshot|toMatchSnapshot|toMatchAriaSnapshot)\s*\(/;

/** The guard's settings from <project>/.claude/qa.json, or null when it's off (missing, invalid, not opted in). */
export function guardConfig(projectDir) {
	let c;
	try {
		c = JSON.parse(readFileSync(path.join(projectDir, ".claude", "qa.json"), "utf8"));
	} catch {
		return null;
	}
	if (!c || c.version !== 1 || c.hooks?.healerGuard !== true) return null;
	const expectedData = Array.isArray(c.expectedData) ? c.expectedData.filter((g) => typeof g === "string" && g.trim()) : [];
	return { expectedData };
}

/** Is this hook input from the healer? `ui-test-healer`, or any plugin's `<plugin>:ui-test-healer`. */
export const isHealer = (agentType) => typeof agentType === "string" && /^(?:[^:]+:)?ui-test-healer$/.test(agentType);

/** A glob ("**" = any folders, "*" = anything but "/", "?" = one char) as an anchored regex. */
export function globToRegex(glob) {
	let re = "";
	const g = glob.replace(/^\.\//, "");
	for (let i = 0; i < g.length; i++) {
		const ch = g[i];
		if (ch === "*" && g[i + 1] === "*") {
			const slash = g[i + 2] === "/";
			re += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

/** The guarded lines of a text, trimmed, sorted (a multiset, so a moved or re-indented line compares equal). */
export function guardedLines(text) {
	return String(text ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => GUARDED_LINE.test(l))
		.sort();
}

/** Lines in one multiset and not the other: [{line, change: "added" | "removed"}]. */
function lineChanges(before, after) {
	const left = [...before];
	const out = [];
	for (const l of after) {
		const i = left.indexOf(l);
		if (i === -1) out.push({ line: l, change: "added" });
		else left.splice(i, 1);
	}
	return [...left.map((l) => ({ line: l, change: "removed" })), ...out];
}

/**
 * The file before and after the tool call, as [before, after] text pairs to compare. Edit / MultiEdit are applied
 * to the file on disk (so an old_string that's only a fragment of an expect line, like `"Total: $20"`, still counts);
 * when the file or an old_string isn't there, the strings themselves are compared.
 */
function editPairs(toolName, toolInput, absFile) {
	const disk = existsSync(absFile) ? readFileSync(absFile, "utf8") : null;
	if (toolName === "Write") return [[disk ?? "", toolInput.content]];
	const edits = toolName === "MultiEdit" ? (Array.isArray(toolInput.edits) ? toolInput.edits : []) : [toolInput];
	let text = disk;
	for (const e of edits) {
		const from = String(e?.old_string ?? "");
		const to = String(e?.new_string ?? "");
		if (text === null || !from || !text.includes(from)) return edits.map((x) => [x?.old_string, x?.new_string]);
		text = e.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
	}
	return [[disk, text]];
}

const cut = (s, max = 100) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const NEXT = 'The healer never heals an expect. Stop: ask the user (show expected vs actual and the requirement it came from), or, with no one to ask, mark the test test.fixme("<question>") and put the question in your report. Don\'t try another way to change it.';

/**
 * The whole hook, as data (tests call it without a child process).
 * @param {object} input Hook input from stdin. @param {object} env process.env.
 * @return {{exit: number, stderr?: string}}
 */
export function healerGuard(input, env = process.env) {
	if (!isHealer(input?.agent_type)) return { exit: 0 };
	const toolInput = input?.tool_input || {};
	const filePath = toolInput.file_path;
	if (!filePath) return { exit: 0 };
	const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
	const cfg = guardConfig(projectDir);
	if (!cfg) return { exit: 0 };
	const absFile = path.resolve(input.cwd || projectDir, filePath);
	const rel = path.relative(projectDir, absFile).split(path.sep).join("/");
	const label = rel.startsWith("..") ? absFile : rel;
	if (!rel.startsWith("..") && cfg.expectedData.some((g) => globToRegex(g).test(rel))) {
		return { exit: 2, stderr: `qa healer guard: blocked an edit to ${label}, which holds expected test data (.claude/qa.json "expectedData"). ${NEXT}` };
	}
	if (!GUARDED_FILE.test(absFile)) return { exit: 0 };
	const changes = editPairs(input.tool_name, toolInput, absFile).flatMap(([before, after]) => lineChanges(guardedLines(before), guardedLines(after)));
	if (!changes.length) return { exit: 0 };
	const list = changes.slice(0, 4).map((c) => `  ${c.change}: ${cut(c.line)}`).join("\n");
	const more = changes.length > 4 ? `\n  …and ${changes.length - 4} more` : "";
	return { exit: 2, stderr: `qa healer guard: blocked an edit to ${label} that changes an expect or a snapshot name:\n${list}${more}\n${NEXT}` };
}

async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	let input;
	try {
		input = JSON.parse(raw || "{}");
	} catch {
		return; // not hook input: nothing to do
	}
	const result = healerGuard(input);
	if (result.stderr) process.stderr.write(`${result.stderr}\n`);
	process.exitCode = result.exit; // not process.exit(): let stderr finish writing on a pipe
}

if (isMain(process.argv[1], import.meta.url)) await main();
