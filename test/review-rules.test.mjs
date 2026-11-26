// docs/review-rules.md is the single source of the review rules; claude-review.yml carries a word-for-word copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
const MARKER = "# from benweese/claude-plugins docs/review-rules.md";

/** The text inside the doc's ```text fence. */
function rulesBlock() {
	const m = /```text\n([^]*?)```/.exec(read("docs/review-rules.md"));
	assert.ok(m, "docs/review-rules.md has a ```text block");
	return m[1].replace(/\n$/, "");
}

test("review rules: the block starts with the source marker and covers every rule", () => {
	const rules = rulesBlock();
	assert.equal(rules.split("\n")[0], MARKER);
	for (const rule of ["Verified:", "Defects:", "Unsure:", "False positives:", "Read-only:", "One review:", "Tests:"]) assert.ok(rules.includes(`\n- ${rule}`), rule);
	assert.match(rules, /current diff/);
	assert.match(rules, /heal changed an `expect`/);
	assert.match(rules, /`\/\/ precondition` comment/);
});

test("review rules: claude-review.yml carries the block word for word, inside its prompt", () => {
	const yml = read(".github/workflows/claude-review.yml");
	const lines = yml.split("\n");
	const start = lines.findIndex((l) => l.trim() === MARKER);
	assert.notEqual(start, -1, "the marker line is in claude-review.yml");
	const indent = /^ */.exec(lines[start])[0];
	const expected = rulesBlock().split("\n");
	const copy = lines.slice(start, start + expected.length).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l));
	assert.deepEqual(copy, expected);
	const promptAt = lines.findIndex((l) => /^\s+prompt: \|$/.test(l));
	const argsAt = lines.findIndex((l) => /^\s+claude_args:/.test(l));
	assert.ok(promptAt !== -1 && promptAt < start && start < argsAt, "inside the prompt: | block");
	assert.ok(indent.length > /^ */.exec(lines[promptAt])[0].length, "indented under prompt: |");
});
