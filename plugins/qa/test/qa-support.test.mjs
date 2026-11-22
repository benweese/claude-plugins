// node:test for qa-support: TS vs JS, bundles, headers, edited vs older copies, conflicts, devDependency plans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compat, depPlan, fileState, install, manifest, plan, repoInfo, status, update } from "../bin/qa-support";

function repo({ ts = true, pkg = {}, qa } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "qa-support-"));
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", ...pkg }));
	if (ts) writeFileSync(path.join(dir, "tsconfig.json"), "{}");
	if (qa) {
		mkdirSync(path.join(dir, ".claude"));
		writeFileSync(path.join(dir, ".claude", "qa.json"), JSON.stringify(qa));
	}
	return dir;
}
const m = manifest();

test("commons installed → nothing to copy, nothing planned", () => {
	const dir = repo({ pkg: { devDependencies: { "@benweese/playwright-test-commons": "github:benweese/playwright-test-commons#v0.7.0" } } });
	assert.match(plan(dir, ["core"]).lines[0], /is installed .* nothing to copy/);
	assert.match(install(dir, ["core", "ui"]).lines[0], /is installed/);
	assert.equal(existsSync(path.join(dir, "tests")), false);
});

test("TypeScript repo: only the bundles asked for, into tests/support/, each with a header", () => {
	const dir = repo();
	const r = install(dir, ["core"]);
	assert.equal(r.ok, true);
	assert.ok(existsSync(path.join(dir, "tests/support/index.ts")));
	assert.ok(existsSync(path.join(dir, "tests/support/validation/validateJsonSchema.ts")));
	assert.equal(existsSync(path.join(dir, "tests/support/ui.ts")), false, "ui wasn't asked for");
	const head = readFileSync(path.join(dir, "tests/support/index.ts"), "utf8").split("\n")[0];
	assert.match(head, new RegExp(`^// qa-support: @benweese/playwright-test-commons ${m.tag} · ts/index\\.ts · sha256:[0-9a-f]{64}$`));
	install(dir, ["ui"]);
	assert.ok(existsSync(path.join(dir, "tests/support/ui/BasePage.ts")));
});

test("plain JS repo (no tsconfig) → compiled .js + .d.ts; supportDir from qa.json", () => {
	const dir = repo({ ts: false, qa: { version: 1, supportDir: "e2e/helpers" } });
	assert.equal(repoInfo(dir).lang, "js");
	install(dir, ["core", "ui"]);
	for (const f of ["index.js", "index.d.ts", "ui.js", "ui.d.ts", "ui/BasePage.js", "helpers/email.d.ts"]) assert.ok(existsSync(path.join(dir, "e2e/helpers", f)), f);
	assert.equal(existsSync(path.join(dir, "e2e/helpers/index.ts")), false);
});

test("later runs: current / older unmodified → update offered / edited → left alone", () => {
	const dir = repo();
	install(dir, ["core"]);
	const f = path.join(dir, "tests/support/helpers/email.ts");
	assert.equal(fileState(f, m).state, "current");
	writeFileSync(f, readFileSync(f, "utf8").replace(` ${m.tag} `, " v0.0.1 "));
	assert.equal(fileState(f, m).state, "older");
	assert.match(plan(dir, ["core"]).lines.join("\n"), /Older unmodified copies .*helpers\/email\.ts/);
	const g = path.join(dir, "tests/support/helpers/polling.ts");
	writeFileSync(g, `${readFileSync(g, "utf8")}\n// my tweak\n`);
	assert.equal(fileState(g, m).state, "edited");
	const u = update(dir);
	assert.match(u.lines[0], /Updated: helpers\/email\.ts \(v0\.0\.1 → /);
	assert.match(u.lines[1], /Left alone \(edited by hand\): helpers\/polling\.ts/);
	assert.equal(fileState(f, m).state, "current");
	assert.match(readFileSync(g, "utf8"), /my tweak/);
});

test("a file qa-support didn't write is a conflict: nothing is copied", () => {
	const dir = repo();
	mkdirSync(path.join(dir, "tests/support"), { recursive: true });
	writeFileSync(path.join(dir, "tests/support/index.ts"), "export const mine = 1;\n");
	const r = install(dir, ["core"]);
	assert.equal(r.ok, false);
	assert.match(r.lines.join("\n"), /CONFLICT .* index\.ts/);
	assert.equal(existsSync(path.join(dir, "tests/support/helpers")), false);
	assert.equal(readFileSync(path.join(dir, "tests/support/index.ts"), "utf8"), "export const mine = 1;\n");
});

test("devDependencies: shown, never written; compatible ones skipped; never a downgrade", () => {
	assert.equal(compat("8.21.0", "^8.20.0"), "ok");
	assert.equal(compat("8.1.0", "^8.20.0"), "older");
	assert.equal(compat("9.0.0", "^8.20.0"), "newer-major");
	assert.equal(compat("0.0.9", "^0.0.8"), "ok");
	assert.equal(compat("1.70.0", ">=1.65.0"), "ok");
	const dir = repo({ pkg: { devDependencies: { ajv: "^8.25.0", dayjs: "^2.0.0", "@playwright/test": "^1.60.0" } } });
	const rows = Object.fromEntries(depPlan(dir, repoInfo(dir), ["core"], m).map((d) => [d.name, d.action]));
	assert.equal(rows.ajv, "skip");
	assert.match(rows.dayjs, /^keep/, "newer major: kept, never downgraded");
	assert.equal(rows["@playwright/test"], "upgrade");
	assert.equal(rows["genson-js"], "add");
	const text = plan(dir, ["core"]).lines.join("\n");
	assert.match(text, /package\.json is NOT edited/);
	assert.match(text, /npm install --save-dev "@playwright\/test@>=1\.65\.0" "ajv-formats@\^3\.0\.1" "genson-js@\^0\.0\.8"/);
	install(dir, ["core"]);
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).devDependencies, { ajv: "^8.25.0", dayjs: "^2.0.0", "@playwright/test": "^1.60.0" }, "untouched");
});

test("status reports what's there", () => {
	const dir = repo();
	assert.match(status(dir).lines.join("\n"), /core: not copied/);
	install(dir, ["ui"]);
	assert.match(status(dir).lines.join("\n"), /ui: \d+\/\d+ files \(current\)/);
});
