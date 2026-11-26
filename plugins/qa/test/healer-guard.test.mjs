// The healer guard: while the ui-test-healer edits, a change to an expect line, a snapshot name or an expected-data
// file is blocked (exit 2). Everyone else edits freely; off unless .claude/qa.json opts in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { globToRegex, GUARDED_FILE, guardConfig, guardedLines, healerGuard, isHealer } from "../scripts/healer-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "healer-guard.mjs");

const SPEC = `import { test, expect } from "@playwright/test";
import { cart } from "../locators/cart";

test("#0012 cart total", async ({ page }) => {
	await page.goto("/cart");
	await page.locator(cart.addButton).click();
	await expect(page).toHaveURL(/cart/); // precondition
	await expect.soft(page.locator(cart.total)).toHaveText("Total: $20");
	await expect.soft(page.locator(cart.items)).toHaveCount(2);
});
`;

/** A project with a spec on disk and (optionally) a .claude/qa.json. */
function project(config = { version: 1, hooks: { healerGuard: true }, expectedData: ["tests/fixtures/expected/**"] }) {
	// config null = no .claude/qa.json at all
	const dir = mkdtempSync(path.join(tmpdir(), "qa-guard-"));
	mkdirSync(path.join(dir, "tests", "ui", "specs"), { recursive: true });
	mkdirSync(path.join(dir, "tests", "fixtures", "expected"), { recursive: true });
	writeFileSync(path.join(dir, "tests", "ui", "specs", "cart.spec.ts"), SPEC);
	writeFileSync(path.join(dir, "tests", "fixtures", "expected", "cart.json"), '{ "total": 20 }\n');
	if (config !== null) {
		mkdirSync(path.join(dir, ".claude"), { recursive: true });
		writeFileSync(path.join(dir, ".claude", "qa.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	return dir;
}
const spec = (dir) => path.join(dir, "tests", "ui", "specs", "cart.spec.ts");
/** Hook input for an Edit; `who` is the agent_type (null = the main session). agent_id only inside a subagent. */
const edit = (dir, old_string, new_string, who = "qa:ui-test-healer", file = spec(dir)) => ({
	hook_event_name: "PreToolUse",
	cwd: dir,
	...(who ? { agent_type: who, agent_id: "a1b2c3" } : {}),
	tool_name: "Edit",
	tool_input: { file_path: file, old_string, new_string }
});
const run = (input, dir) => healerGuard(input, { CLAUDE_PROJECT_DIR: dir });
const blocked = (r) => r.exit === 2;

test("guard: an expect's value changed, an expect removed, soft → hard → all blocked", () => {
	const dir = project();
	const total = `	await expect.soft(page.locator(cart.total)).toHaveText("Total: $20");`;
	const value = run(edit(dir, total, total.replace("$20", "$25")), dir);
	assert.ok(blocked(value));
	assert.match(value.stderr, /changes an expect or a snapshot name/);
	assert.match(value.stderr, /removed: await expect\.soft\(page\.locator\(cart\.total\)\)\.toHaveText\("Total: \$20"\);/);
	assert.match(value.stderr, /added: .*\$25/);
	assert.match(value.stderr, /ask the user .*test\.fixme\("<question>"\)/);
	assert.ok(blocked(run(edit(dir, `${total}\n`, ""), dir)), "removed");
	assert.ok(blocked(run(edit(dir, total, total.replace("expect.soft(", "expect(")), dir)), "soft → hard");
	assert.ok(blocked(run(edit(dir, `	await expect(page).toHaveURL(/cart/); // precondition`, `	await expect.soft(page).toHaveURL(/cart/);`), dir)), "hard → soft");
	assert.ok(blocked(run(edit(dir, total, total.replace("toHaveText", "toContainText")), dir)), "matcher weakened");
	assert.ok(blocked(run(edit(dir, "	await page.goto(\"/cart\");", "	await page.goto(\"/cart\");\n	expect(1).toBe(1);"), dir)), "an expect added");
	// old_string can be a fragment of an expect line: the edit is applied to the file, so it still counts.
	assert.ok(blocked(run(edit(dir, '"Total: $20"', '"Total: $25"'), dir)), "only the expected value");
	assert.ok(blocked(run(edit(dir, "toHaveCount(2)", "toHaveCount(3)"), dir)), "only the matcher call");
	assert.ok(blocked(run({ ...edit(dir, ".soft", ""), tool_input: { file_path: spec(dir), old_string: ".soft", new_string: "", replace_all: true } }, dir)), "replace_all soft → hard");
});

test("guard: locator, wait and navigation lines, test.fixme, and re-indenting pass", () => {
	const dir = project();
	assert.deepEqual(run(edit(dir, "	await page.locator(cart.addButton).click();", "	await page.getByRole(\"button\", { name: \"Add to cart\" }).click();"), dir), { exit: 0 }, "locator-only");
	assert.deepEqual(run(edit(dir, "	await page.goto(\"/cart\");", "	await page.goto(\"/cart\");\n	await page.locator(cart.total).waitFor();"), dir), { exit: 0 }, "a wait");
	assert.deepEqual(run(edit(dir, 'test("#0012 cart total", async ({ page }) => {', 'test.fixme("#0012 cart total", async ({ page }) => {'), dir), { exit: 0 }, "test.fixme on the test");
	assert.deepEqual(run(edit(dir, "	await page.goto(\"/cart\");", '	test.fixme(true, "total shows $25, plan says $20: which is right?");\n	await page.goto("/cart");'), dir), { exit: 0 }, "a test.fixme line");
	const block = SPEC.slice(SPEC.indexOf("	await expect("), SPEC.indexOf("});"));
	assert.deepEqual(run(edit(dir, block, block.replace(/^\t/gm, "\t\t")), dir), { exit: 0 }, "re-indented expects");
});

test("guard: other agents and the main session edit freely; the healer from any plugin or --agent is guarded", () => {
	const dir = project();
	const total = `	await expect.soft(page.locator(cart.total)).toHaveText("Total: $20");`;
	const change = (who) => run(edit(dir, total, total.replace("$20", "$25"), who), dir);
	assert.deepEqual(change(null), { exit: 0 }, "main session");
	for (const who of ["qa:ui-test-generator", "Explore", "general-purpose", "qa:ui-test-healer-v2", "ui-test-healer:other"]) assert.deepEqual(change(who), { exit: 0 }, who);
	for (const who of ["ui-test-healer", "qa:ui-test-healer", "playwright-qa-agents:ui-test-healer"]) assert.ok(blocked(change(who)), who);
	// `claude --agent qa:ui-test-healer`: agent_type on the main thread, no agent_id.
	const mainThread = { ...edit(dir, total, total.replace("$20", "$25")) };
	delete mainThread.agent_id;
	assert.ok(blocked(run(mainThread, dir)), "--agent session (no agent_id)");
	assert.equal(isHealer(null), false);
});

test("guard: expected-data files are blocked for the healer, whatever the change; other files aren't", () => {
	const dir = project();
	const data = path.join(dir, "tests", "fixtures", "expected", "cart.json");
	const r = run(edit(dir, '"total": 20', '"total": 25', "qa:ui-test-healer", data), dir);
	assert.ok(blocked(r));
	assert.match(r.stderr, /tests\/fixtures\/expected\/cart\.json, which holds expected test data/);
	assert.ok(blocked(run(edit(dir, '"total": 20', '"total": 25', "qa:ui-test-healer", "tests/fixtures/expected/cart.json"), dir)), "a relative path");
	assert.deepEqual(run(edit(dir, '"total": 20', '"total": 25', "qa:ui-test-generator", data), dir), { exit: 0 }, "another agent");
	assert.deepEqual(run(edit(dir, "a", "b", "qa:ui-test-healer", path.join(dir, "tests", "ui", "locators", "cart.ts")), dir), { exit: 0 }, "a locators file");
	for (const [glob, yes, no] of [["tests/fixtures/expected/**", "tests/fixtures/expected/a/b.json", "tests/fixtures/x.json"], ["**/*-snapshots/**", "tests/ui/cart.spec.ts-snapshots/total.png", "tests/ui/cart.spec.ts"], ["data/*.json", "data/a.json", "data/sub/a.json"], ["./exp?.txt", "exp1.txt", "exp12.txt"]]) {
		assert.ok(globToRegex(glob).test(yes), `${glob} ~ ${yes}`);
		assert.ok(!globToRegex(glob).test(no), `${glob} !~ ${no}`);
	}
});

test("guard: Write is judged against the file on disk; MultiEdit edit by edit; snapshot names count", () => {
	const dir = project();
	const write = (content) => run({ cwd: dir, agent_type: "qa:ui-test-healer", tool_name: "Write", tool_input: { file_path: spec(dir), content } }, dir);
	assert.deepEqual(write(SPEC.replace("cart.addButton", "cart.addToCartButton")), { exit: 0 }, "a Write that only changes a locator");
	assert.ok(blocked(write(SPEC.replace("$20", "$25"))), "a Write that changes an expect");
	const created = run({ cwd: dir, agent_type: "qa:ui-test-healer", tool_name: "Write", tool_input: { file_path: path.join(dir, "tests", "ui", "specs", "new.spec.ts"), content: SPEC } }, dir);
	assert.ok(blocked(created), "a new spec file adds expects");
	const multi = (edits) => run({ cwd: dir, agent_type: "qa:ui-test-healer", tool_name: "MultiEdit", tool_input: { file_path: spec(dir), edits } }, dir);
	assert.deepEqual(multi([{ old_string: "cart.addButton", new_string: "cart.add" }]), { exit: 0 });
	assert.ok(blocked(multi([{ old_string: "cart.addButton", new_string: "cart.add" }, { old_string: "toHaveCount(2)", new_string: "toHaveCount(3)" }])));
	const snap = `	await expect(page).toHaveScreenshot("cart.png");`;
	assert.ok(blocked(run(edit(dir, snap, snap.replace("cart.png", "cart-v2.png")), dir)), "snapshot name");
	assert.ok(blocked(run(edit(dir, `	await region.toMatchAriaSnapshot({ name: "cart.aria.yml" });`, `	await region.toMatchAriaSnapshot({ name: "cart2.aria.yml" });`), dir)), "a snapshot matcher line without expect(");
	assert.deepEqual(guardedLines("  expect(a).toBe(1);\nfoo();\n\texpect.soft(b).toBe(2);"), ["expect(a).toBe(1);", "expect.soft(b).toBe(2);"]);
	assert.deepEqual(guardedLines("myexpect(a); obj.expectText(x); expectNoA11yViolations(page);"), [], "helpers and look-alikes aren't expect lines");
	assert.deepEqual(guardedLines("await expect.poll(() => total()).toBe(20);\nconst soft = expect.configure({ soft: true });"), ["await expect.poll(() => total()).toBe(20);", "const soft = expect.configure({ soft: true });"]);
	const poll = "	await expect.soft(page.locator(cart.items)).toHaveCount(2);";
	assert.ok(blocked(run(edit(dir, poll, "	await expect.poll(() => page.locator(cart.items).count()).toBe(3);"), dir)), "an expect.poll value");
});

test("guard: off when .claude/qa.json is missing, invalid, another version, or healerGuard isn't true; non-test files pass", () => {
	const total = `	await expect.soft(page.locator(cart.total)).toHaveText("Total: $20");`;
	for (const config of [null, "{not json", { version: 2, hooks: { healerGuard: true } }, { version: 1 }, { version: 1, hooks: { healerGuard: "yes" } }, { version: 1, hooks: { lintAfterEdit: true } }]) {
		const dir = project(config);
		assert.deepEqual(run(edit(dir, total, total.replace("$20", "$25")), dir), { exit: 0 }, JSON.stringify(config));
		assert.equal(guardConfig(dir), null);
	}
	const dir = project({ version: 1, hooks: { healerGuard: true }, expectedData: "not-an-array" });
	assert.deepEqual(guardConfig(dir), { expectedData: [] });
	assert.deepEqual(run(edit(dir, "expect(a)", "expect(b)", "qa:ui-test-healer", path.join(dir, "src", "page.ts")), dir), { exit: 0 }, "not a test file, not expected data");
	for (const f of ["a.spec.ts", "a.test.mjs", "a.spec.tsx", "a.test.py", "a.spec.mts"]) assert.match(f, GUARDED_FILE, f);
	for (const f of ["spec.ts", "a.specs.ts", "page.ts", "a.spec"]) assert.doesNotMatch(f, GUARDED_FILE, f);
});

test("hooks.json: the guard runs before Edit | Write | MultiEdit", () => {
	const hooks = JSON.parse(readFileSync(path.join(HERE, "..", "hooks", "hooks.json"), "utf8")).hooks;
	const pre = hooks.PreToolUse.find((m) => m.hooks.some((h) => h.command.includes("healer-guard.mjs")));
	assert.equal(pre.matcher, "Edit|Write|MultiEdit");
});

test("as a real hook: a healer expect edit → exit 2 with the reason on stderr; a locator edit → exit 0, no output", { skip: process.platform === "win32" }, () => {
	const dir = project();
	const total = `	await expect.soft(page.locator(cart.total)).toHaveText("Total: $20");`;
	const hook = (input) => spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
	const no = hook(edit(dir, total, total.replace("$20", "$25")));
	assert.equal(no.status, 2);
	assert.match(no.stderr, /^qa healer guard: blocked an edit to tests\/ui\/specs\/cart\.spec\.ts/);
	assert.equal(no.stdout, "");
	const ok = hook(edit(dir, "cart.addButton", "cart.add"));
	assert.equal(ok.status, 0);
	assert.equal(ok.stdout + ok.stderr, "");
});
