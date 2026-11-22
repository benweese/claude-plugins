#!/usr/bin/env node
// qa PostToolUse hook on Bash (opt-in: .claude/qa.json "hooks": { "autoReview": true }): after the test suite
// goes green, asks Claude to run the test-reviewer — once per green run, only if the test files changed since
// the last review, at most 2 automatic reviews per task (then only /review-tests). PostToolUse only fires when
// the command succeeded (a failing command fires PostToolUseFailure), and the output is checked for failures too.
// Hook format: https://code.claude.com/docs/en/hooks
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentBranch, ignoreWarning, readRequirements, readState, testFilesHash, writeState } from "./requirements.mjs";

export const MAX_AUTO = 2;

/** Is this command a test run (not --list / --help / show-report / codegen / install …)? */
export function isTestRun(command) {
	const c = String(command || "");
	const pw = /(?:^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?playwright\s+test\b(.*)/.exec(c);
	if (pw) return !/(?:^|\s)(?:--list|--help|-h|--ui|--last-failed-list)(?:\s|=|$)/.test(pw[1]);
	if (/(?:^|[\s;&|(])(?:npx\s+)?playwright\s+(?:show-report|codegen|install|merge-reports|show-trace|open|cr|ff|wk|uninstall)\b/.test(c)) return false;
	if (/(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:-]+)?(?:\s|$)/.test(c)) return !/\s--\s.*(?:--list|--help)/.test(c);
	if (/(?:^|[\s;&|(])(?:npx\s+)?(?:vitest|jest)(?:\s+run)?(?:\s|$)/.test(c)) return !/--(?:help|listTests|list)\b/.test(c);
	return false;
}

/** Did the output report failures (e.g. `npm test || true`)? */
export function outputFailed(response) {
	const text = typeof response === "string" ? response : `${response?.stdout || ""}\n${response?.stderr || ""}`;
	if (response && response.interrupted) return true;
	return /\b[1-9]\d* (?:failed|failing)\b|Tests?:\s+[1-9]\d* failed|✘|\bFAIL\b/.test(text);
}

function qaAutoReviewOn(root) {
	try {
		const c = JSON.parse(readFileSync(path.join(root, ".claude", "qa.json"), "utf8"));
		return c.version === 1 && c.hooks?.autoReview === true;
	} catch {
		return false;
	}
}

/** The whole hook, as data: {exit, json?}. */
export function reviewGuard(input, env = process.env) {
	const root = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
	if (!qaAutoReviewOn(root)) return { exit: 0 };
	if (!isTestRun(input?.tool_input?.command) || outputFailed(input?.tool_response)) return { exit: 0 };
	const warn = ignoreWarning(root);
	const say = (ctx, note) => ({
		exit: 0,
		json: { ...(note || warn ? { systemMessage: [note, warn].filter(Boolean).join(" · ") } : {}), ...(ctx ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } } : {}) }
	});
	const req = readRequirements(root);
	if (!req) return warn ? say(null, null) : { exit: 0 };
	const branch = currentBranch(root);
	if (req.branch !== branch) return say(null, `qa: tests are green, but the saved requirement is from branch "${req.branch}" (you're on "${branch}") — save this task's requirement before reviewing`);
	const files = testFilesHash(root);
	const prev = readState(root);
	const state = prev && prev.task === req.task ? prev : { task: req.task, reviewedHash: null, autoCount: 0 }; // new task → counter resets
	if (state.reviewedHash === files.hash) return warn ? say(null, null) : { exit: 0 }; // these tests were already reviewed
	if (state.autoCount >= MAX_AUTO) return say(null, `qa: tests are green; ${MAX_AUTO} automatic reviews already ran for this task — run /review-tests to review again`);
	writeState(root, { task: req.task, reviewedHash: files.hash, autoCount: state.autoCount + 1 });
	return say(
		`The test suite is green for the current task (requirement: ${req.source}${req.ref ? ` ${req.ref}` : ""}, task ${req.task}). Run /review-tests now: the test-reviewer checks the tests against .claude/qa/requirements.md (report only — don't change tests until the user approves). Automatic review ${state.autoCount + 1} of ${MAX_AUTO} for this task.`,
		null
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	let raw = "";
	for await (const c of process.stdin) raw += c;
	let input = {};
	try {
		input = JSON.parse(raw || "{}");
	} catch {
		/* not hook input */
	}
	const r = reviewGuard(input);
	if (r.json && Object.keys(r.json).length) process.stdout.write(`${JSON.stringify(r.json)}\n`);
	process.exit(r.exit);
}
