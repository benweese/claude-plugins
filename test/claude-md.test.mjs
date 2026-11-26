// The root CLAUDE.md stays short and points at the sources it doesn't restate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");

test("CLAUDE.md: under 50 lines, and every path or workflow it names exists", () => {
	const md = read("CLAUDE.md");
	const lines = md.trimEnd().split("\n").length;
	assert.ok(lines < 50, `${lines} lines`);
	const paths = [...new Set([...md.matchAll(/\b((?:docs|scripts)\/[\w.-]+\.(?:md|mjs)|README\.md)\b/g)].map((m) => m[1]))];
	const workflows = [...md.matchAll(/`([\w-]+\.yml)`/g)].map((m) => `.github/workflows/${m[1]}`);
	assert.ok(paths.length >= 5 && workflows.length >= 3, `found ${paths.length} paths, ${workflows.length} workflows`);
	for (const f of [...paths, ...workflows]) assert.ok(existsSync(path.join(ROOT, f)), `${f} exists`);
});

test("CLAUDE.md: its test and validate commands are the ones CI runs", () => {
	const md = read("CLAUDE.md");
	const cmd = /`(node --test [^`]+)`/.exec(md)?.[1];
	assert.ok(cmd, "CLAUDE.md has a node --test command");
	assert.ok(read(".github/workflows/claude-review.yml").includes(cmd), "same command in claude-review.yml");
	assert.ok(read(".github/workflows/validate.yml").includes(cmd), "same command in validate.yml");
	assert.match(md, /`claude plugin validate plugins\/<name> --strict`/);
	assert.match(read(".github/workflows/validate.yml"), /claude plugin validate .*--strict/);
});
