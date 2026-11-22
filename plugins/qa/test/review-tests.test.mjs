// node:test for /review-tests plumbing: requirements file, test-run detection, the auto-review loop guard.
// (The reviewer's judgment is checked live against examples/sample-app/fixtures/review-tests.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readRequirements, saveRequirements, testFilesHash } from "../scripts/requirements.mjs";
import { MAX_AUTO, isTestRun, outputFailed, reviewGuard } from "../scripts/review-guard.mjs";
import { run } from "../bin/qa-requirements";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples", "sample-app", "fixtures", "review-tests");

function repo({ optIn = true, ignore = true } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "review-"));
	const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
	g("init", "-q", "-b", "main");
	g("config", "user.email", "t@example.invalid");
	g("config", "user.name", "T");
	if (ignore) writeFileSync(path.join(dir, ".gitignore"), ".claude/qa/\n");
	mkdirSync(path.join(dir, "tests"), { recursive: true });
	writeFileSync(path.join(dir, "tests", "a.spec.ts"), "test('x', () => {});\n");
	if (optIn) {
		mkdirSync(path.join(dir, ".claude"), { recursive: true });
		writeFileSync(path.join(dir, ".claude", "qa.json"), JSON.stringify({ version: 1, hooks: { autoReview: true } }));
	}
	g("add", ".");
	g("commit", "-qm", "init");
	return { dir, g };
}
const green = (dir, command = "npx playwright test") => ({ cwd: dir, tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "  4 passed (2.1s)", stderr: "", interrupted: false } });
const env = (dir) => ({ CLAUDE_PROJECT_DIR: dir });
const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext;

test("test-run detection: real runs yes; --list, --help, show-report, codegen, install no", () => {
	for (const c of ["npx playwright test", "playwright test tests/api", "npx playwright test --grep #0012", "npm test", "npm run test:api", "pnpm test", "yarn test", "npx vitest run", "cd e2e && npx playwright test --project=api"]) assert.equal(isTestRun(c), true, c);
	for (const c of ["npx playwright test --list", "npx playwright test --help", "npx playwright test -h", "npx playwright show-report", "npx playwright codegen http://localhost", "npx playwright install chromium", "npx playwright test --ui", "npm run lint", "git status", "npm install", "npx jest --listTests"]) assert.equal(isTestRun(c), false, c);
});

test("green means no failure in the output either (e.g. npm test || true)", () => {
	assert.equal(outputFailed({ stdout: "  4 passed", interrupted: false }), false);
	assert.equal(outputFailed({ stdout: "  1 failed\n  3 passed" }), true);
	assert.equal(outputFailed({ stdout: "Tests: 2 failed, 5 passed" }), true);
	assert.equal(outputFailed({ stdout: "ok", interrupted: true }), true);
});

test("requirements.md: verbatim body, header with source / branch; parse round-trip; task changes with body or branch", () => {
	const { dir, g } = repo();
	const r = saveRequirements(dir, { source: "chat", text: "Test the cart:\n1. add\n2. remove\n" });
	const back = readRequirements(dir);
	assert.equal(back.body, "Test the cart:\n1. add\n2. remove");
	assert.deepEqual([back.source, back.branch, back.task], ["chat", "main", r.task]);
	assert.match(readFileSync(path.join(dir, ".claude/qa/requirements.md"), "utf8"), /^<!-- qa-requirements v1 -->\nsource: chat\nbranch: main\nsaved: \S+\n---\n/);
	g("switch", "-qc", "feature");
	assert.notEqual(saveRequirements(dir, { source: "chat", text: "Test the cart:\n1. add\n2. remove\n" }).task, r.task, "another branch = another task");
	assert.throws(() => saveRequirements(dir, { source: "chat", text: "  " }), /empty/);
});

test("qa-requirements CLI: save / show; warns on every run when requirements.md isn't gitignored", () => {
	const { dir } = repo({ ignore: false });
	const out = run(dir, ["save", "chat"], "Check the login page");
	assert.match(out, /Saved the chat requirement .* branch main/);
	assert.match(out, /isn't gitignored/);
	assert.match(run(dir, ["show"]), /source chat · branch main[\s\S]*Check the login page[\s\S]*isn't gitignored/);
	const ok = repo();
	run(ok.dir, ["save", "chat"], "x");
	assert.doesNotMatch(run(ok.dir, ["show"]), /gitignored/);
	writeFileSync(path.join(ok.dir, "req.txt"), "From a file\n");
	assert.match(run(ok.dir, ["save", "file", "req.txt"]), /Saved the file requirement/);
	assert.equal(readRequirements(ok.dir).body, "From a file");
});

test("auto-review: off unless opted in; needs a saved requirement; non-test commands ignored", () => {
	const off = repo({ optIn: false });
	saveRequirements(off.dir, { source: "chat", text: "x" });
	assert.deepEqual(reviewGuard(green(off.dir), env(off.dir)), { exit: 0 });
	const on = repo();
	assert.equal(ctx(reviewGuard(green(on.dir), env(on.dir))), undefined, "no requirement saved");
	saveRequirements(on.dir, { source: "chat", text: "x" });
	assert.equal(ctx(reviewGuard(green(on.dir, "npx playwright test --list"), env(on.dir))), undefined);
	assert.equal(ctx(reviewGuard(green(on.dir, "npx playwright show-report"), env(on.dir))), undefined);
});

test(`auto-review loop guard: once per green run, only when tests changed, at most ${MAX_AUTO} per task; new task resets`, () => {
	const { dir, g } = repo();
	saveRequirements(dir, { source: "issue", ref: "12", text: "R1 …" });
	assert.match(ctx(reviewGuard(green(dir), env(dir))), /Run \/review-tests now[\s\S]*1 of 2/);
	assert.equal(ctx(reviewGuard(green(dir), env(dir))), undefined, "same tests → no second review");
	writeFileSync(path.join(dir, "tests", "a.spec.ts"), "test('x', () => { /* changed */ });\n");
	assert.match(ctx(reviewGuard(green(dir), env(dir))), /2 of 2/);
	writeFileSync(path.join(dir, "tests", "b.spec.ts"), "test('y', () => {});\n");
	const capped = reviewGuard(green(dir), env(dir));
	assert.equal(ctx(capped), undefined);
	assert.match(capped.json.systemMessage, /2 automatic reviews already ran .* \/review-tests/);
	saveRequirements(dir, { source: "issue", ref: "13", text: "a different request" });
	assert.match(ctx(reviewGuard(green(dir), env(dir))), /1 of 2/, "new requirement = new task, count reset");
	g("switch", "-qc", "other");
	const r = reviewGuard(green(dir), env(dir));
	assert.equal(ctx(r), undefined);
	assert.match(r.json.systemMessage, /saved requirement is from branch "main" \(you're on "other"\)/);
});

test("test files hash: changes when a spec changes, not when other files do", () => {
	const { dir } = repo();
	const a = testFilesHash(dir).hash;
	writeFileSync(path.join(dir, "notes.md"), "hello\n");
	assert.equal(testFilesHash(dir).hash, a);
	writeFileSync(path.join(dir, "tests", "a.spec.ts"), "changed\n");
	assert.notEqual(testFilesHash(dir).hash, a);
});

test("the review fixture holds the planted gap, partial, weak test, scope creep and plan drift", () => {
	const req = readFileSync(path.join(FIXTURE, ".claude/qa/requirements.md"), "utf8");
	const spec = readFileSync(path.join(FIXTURE, "tests/api/books.spec.ts"), "utf8");
	const plan = readFileSync(path.join(FIXTURE, "plans/books-api.md"), "utf8");
	assert.match(req, /^<!-- qa-requirements v1 -->/);
	assert.match(req, /over 120 characters/);
	assert.doesNotMatch(spec, /121|120/, "gap: no long-title test");
	assert.match(spec, /toBeLessThan\(500\)/, "weak test");
	assert.match(spec, /request\.delete/, "scope creep");
	assert.match(req, /missing title or author/);
	assert.doesNotMatch(plan, /or author/, "plan dropped 'or author'");
	assert.ok(existsSync(path.join(FIXTURE, "README.md")));
});
