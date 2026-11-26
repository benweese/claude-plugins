// node:test for the qa test-file hook: match / clean / disabled / missing-tool, plus a config in a subfolder.
// Stub eslint / playwright binaries record their cwd and args, so nothing real is installed or downloaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, hardExpectsWithoutPrecondition, hookEnabled, findPlaywrightRoot, TEST_FILE } from "../scripts/test-file-check.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "test-file-check.mjs");
const unix = process.platform !== "win32";

/** A throwaway project. opts: config (qa.json object or raw string), pwDir ('' = root), bins {eslint, playwright: exit code}. */
function project({ config = { version: 1, hooks: { lintAfterEdit: true } }, pwDir = "", bins = { eslint: 0, playwright: 0 } } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "qa-hook-"));
	if (config !== null) {
		mkdirSync(path.join(dir, ".claude"));
		writeFileSync(path.join(dir, ".claude", "qa.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	const pwRoot = path.join(dir, pwDir);
	mkdirSync(path.join(pwRoot, "tests"), { recursive: true });
	writeFileSync(path.join(pwRoot, "playwright.config.ts"), "export default {};\n");
	writeFileSync(path.join(pwRoot, "tests", "cart.spec.ts"), "// test\n");
	mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
	for (const [name, code] of Object.entries(bins)) {
		const bin = path.join(dir, "node_modules", ".bin", name);
		writeFileSync(bin, `#!/bin/sh\necho "$PWD|$*" >> "${path.join(dir, `${name}.log`)}"\n${code ? `echo "${name} found a problem"; exit ${code}` : "exit 0"}\n`);
		chmodSync(bin, 0o755);
	}
	return { dir, pwRoot, log: (name) => (existsSync(path.join(dir, `${name}.log`)) ? readFileSync(path.join(dir, `${name}.log`), "utf8").trim() : "") };
}
const input = (dir, file, tool = "Edit") => ({ cwd: dir, tool_name: tool, tool_input: { file_path: file } });
const env = (dir) => ({ CLAUDE_PROJECT_DIR: dir });

test("match: *.{spec,test}.{ts,js,mjs,cjs} only", () => {
	for (const f of ["a.spec.ts", "a.test.ts", "b.spec.js", "c.test.mjs", "d.spec.cjs"]) assert.ok(TEST_FILE.test(f), f);
	for (const f of ["a.ts", "spec.ts", "a.spec.tsx", "a.specs.ts", "a.test.json", "page.ts"]) assert.ok(!TEST_FILE.test(f), f);
});

test("disabled: no qa.json, invalid JSON, wrong version or lintAfterEdit not true → off, nothing runs", { skip: !unix }, () => {
	for (const config of [null, "{not json", { version: 2, hooks: { lintAfterEdit: true } }, { version: 1, hooks: { lintAfterEdit: "yes" } }, { version: 1 }]) {
		const p = project({ config });
		assert.equal(hookEnabled(p.dir), false);
		assert.deepEqual(check(input(p.dir, path.join(p.pwRoot, "tests", "cart.spec.ts")), env(p.dir)), { exit: 0 });
		assert.equal(p.log("eslint"), "");
	}
});

test("clean: both pass → exit 0 with a note that includes the elapsed time; run from the config's folder", { skip: !unix }, () => {
	const p = project();
	const r = check(input(p.dir, path.join(p.pwRoot, "tests", "cart.spec.ts")), env(p.dir));
	assert.equal(r.exit, 0);
	assert.match(r.note, /^qa hook: tests\/cart\.spec\.ts — lint \+ --list OK \(\d+\.\ds\)$/);
	assert.equal(p.log("eslint"), `${p.pwRoot}|tests/cart.spec.ts`);
	assert.equal(p.log("playwright"), `${p.pwRoot}|test --list tests/cart.spec.ts`);
});

test("a non-test file or a non-Playwright folder → silent", { skip: !unix }, () => {
	const p = project();
	assert.deepEqual(check(input(p.dir, path.join(p.pwRoot, "tests", "helpers.ts")), env(p.dir)), { exit: 0 });
	const q = project();
	const elsewhere = path.join(q.dir, "scripts");
	mkdirSync(elsewhere);
	writeFileSync(path.join(q.pwRoot, "playwright.config.ts"), ""); // config only at root…
	assert.equal(findPlaywrightRoot(path.join(elsewhere, "x.test.mjs"), q.dir), q.dir); // …so root counts (walk up)
	const r = project({ pwDir: "e2e" });
	assert.equal(findPlaywrightRoot(path.join(r.dir, "src", "unit.test.ts"), r.dir), null);
	assert.deepEqual(check(input(r.dir, path.join(r.dir, "src", "unit.test.ts")), env(r.dir)), { exit: 0 });
});

test("config in a subfolder (e2e/): nearest config wins; eslint and --list run from e2e/", { skip: !unix }, () => {
	const p = project({ pwDir: "e2e" });
	const r = check(input(p.dir, path.join(p.dir, "e2e", "tests", "cart.spec.ts")), env(p.dir));
	assert.equal(r.exit, 0);
	assert.equal(p.log("eslint"), `${path.join(p.dir, "e2e")}|tests/cart.spec.ts`);
	assert.equal(p.log("playwright"), `${path.join(p.dir, "e2e")}|test --list tests/cart.spec.ts`);
});

test("eslint or --list fails → exit 2 with the tool output for Claude", { skip: !unix }, () => {
	const p = project({ bins: { eslint: 1, playwright: 0 } });
	const r = check(input(p.dir, path.join(p.pwRoot, "tests", "cart.spec.ts"), "Write"), env(p.dir));
	assert.equal(r.exit, 2);
	assert.match(r.stderr, /^qa hook: tests\/cart\.spec\.ts \(\d+\.\ds, in \.\)\n✗ eslint\neslint found a problem$/);
	const q = project({ bins: { eslint: 0, playwright: 1 } });
	assert.match(check(input(q.dir, path.join(q.pwRoot, "tests", "cart.spec.ts")), env(q.dir)).stderr, /✗ playwright test --list\nplaywright found a problem/);
});

test("missing tool → a visible 'skipped' note, never a silent pass; the other check still runs", { skip: !unix }, () => {
	const p = project({ bins: { playwright: 0 } });
	const r = check(input(p.dir, path.join(p.pwRoot, "tests", "cart.spec.ts")), env(p.dir));
	assert.equal(r.exit, 0);
	assert.match(r.note, /lint skipped — eslint isn't installed in this project/);
	assert.notEqual(p.log("playwright"), "");
	const q = project({ bins: { eslint: 1 } });
	const s = check(input(q.dir, path.join(q.pwRoot, "tests", "cart.spec.ts")), env(q.dir));
	assert.equal(s.exit, 2);
	assert.match(s.stderr, /\(--list skipped — @playwright\/test isn't installed in this project\)/);
});

test("the 60 s cap: a check past the cap is reported as skipped", { skip: !unix }, () => {
	const p = project();
	let t = 0;
	const clock = () => (t += 61_000); // every call jumps past the cap
	const r = check(input(p.dir, path.join(p.pwRoot, "tests", "cart.spec.ts")), env(p.dir), clock);
	assert.match(r.note, /eslint skipped — the 60s cap was reached/);
});

test("as a real hook: stdin JSON in, systemMessage JSON out", { skip: !unix }, () => {
	const p = project();
	const res = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input(p.dir, path.join(p.pwRoot, "tests", "cart.spec.ts"))), env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir }, encoding: "utf8" });
	assert.equal(res.status, 0);
	assert.match(JSON.parse(res.stdout).systemMessage, /lint \+ --list OK/);
	const bad = project({ bins: { eslint: 2, playwright: 0 } });
	const res2 = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input(bad.dir, path.join(bad.pwRoot, "tests", "cart.spec.ts"))), env: { ...process.env, CLAUDE_PROJECT_DIR: bad.dir }, encoding: "utf8" });
	assert.equal(res2.status, 2);
	assert.match(res2.stderr, /✗ eslint/);
});

test("hard expects: a bare expect( without // precondition on the same line is flagged; soft, poll, helpers and the stop line aren't", () => {
	const text = [
		'await expect(page).toHaveURL(/cart/); // precondition', // 1 ok
		"await expect(page.locator(total)).toHaveText(\"$20\");", // 2 flagged
		"await expect.soft(page.locator(items)).toHaveCount(2);", // 3 ok
		"expect(test.info().errors).toHaveLength(0);", // 4 ok: Playwright's stop-after-soft-checks line
		"await expect.poll(() => count()).toBe(3);", // 5 ok: not a bare expect(
		"await cartPage.expectText(total, \"$20\");", // 6 ok: a helper
		"expect (value).toBe(1); //precondition", // 7 ok
		"  expect(a).toBe(b) // a comment, not the marker", // 8 flagged
		"const myexpect = 1; myexpect(2);" // 9 ok
	].join("\n");
	assert.deepEqual(hardExpectsWithoutPrecondition(text), [2, 8]);
});

test("hard expects: the hook warns Claude (additionalContext) on any exit, and adds a count to the note", { skip: !unix }, () => {
	const p = project();
	const file = path.join(p.pwRoot, "tests", "cart.spec.ts");
	writeFileSync(file, 'await expect(page).toHaveURL(/cart/); // precondition\nawait expect(total).toHaveText("$20");\n');
	const r = check(input(p.dir, file), env(p.dir));
	assert.equal(r.exit, 0);
	assert.match(r.context, /^qa hook: hard expect without a \/\/ precondition comment at tests\/cart\.spec\.ts:2\. Assertions are soft by default/);
	assert.match(r.note, / · 1 hard expect\(s\) without \/\/ precondition$/);
	const failing = project({ bins: { eslint: 1, playwright: 0 } });
	const f2 = path.join(failing.pwRoot, "tests", "cart.spec.ts");
	writeFileSync(f2, "expect(a).toBe(1);\n");
	const r2 = check(input(failing.dir, f2), env(failing.dir));
	assert.equal(r2.exit, 2);
	assert.match(r2.context, /cart\.spec\.ts:1/);
	writeFileSync(file, "await expect.soft(total).toHaveText(\"$20\");\n");
	assert.equal(check(input(p.dir, file), env(p.dir)).context, undefined, "all soft: no warning");
	const off = project({ config: null });
	const f3 = path.join(off.pwRoot, "tests", "cart.spec.ts");
	writeFileSync(f3, "expect(a).toBe(1);\n");
	assert.deepEqual(check(input(off.dir, f3), env(off.dir)), { exit: 0 }, "off: no warning either");
});

test("hard expects (real hook): the warning reaches Claude as PostToolUse additionalContext", { skip: !unix }, () => {
	const p = project();
	const file = path.join(p.pwRoot, "tests", "cart.spec.ts");
	writeFileSync(file, "expect(a).toBe(1);\n");
	const res = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input(p.dir, file)), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir } });
	assert.equal(res.status, 0);
	const out = JSON.parse(res.stdout.trim());
	assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
	assert.match(out.hookSpecificOutput.additionalContext, /cart\.spec\.ts:1/);
	assert.match(out.systemMessage, /lint \+ --list OK/);
});
