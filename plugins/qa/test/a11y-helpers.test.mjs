// Real Playwright run of the qa plugin's a11y helpers (templates/a11y) against examples/sample-app: the good page
// (/) passes every check, the broken fixture (/a11y-broken) fails each one for the planted reason. Runs only when
// A11Y_NODE_MODULES points at a node_modules with @playwright/test and a Chromium browser (CI sets it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { install } from "../bin/qa-support";

const NM = process.env.A11Y_NODE_MODULES;

const SPEC = `import { test, expect } from "@playwright/test";
import { expectEscapeCloses, expectFocusTrapped, expectReflow, expectTabOrder, expectVisibleFocus, withMedia } from "../support/a11y.js";

test.describe("good", () => {
	test.beforeEach(async ({ page }) => { await page.goto("/"); await expect(page.getByRole("status")).not.toHaveText("Loading…"); });
	test("tab order", async ({ page }) => {
		await expectTabOrder(page, [page.getByLabel("Title"), page.getByLabel("Author"), page.getByRole("button", { name: "Add book" }), page.getByRole("button", { name: "About this list" })]);
	});
	test("wrong order is caught", async ({ page }) => {
		await expectTabOrder(page, [page.getByLabel("Author"), page.getByLabel("Title")]);
	});
	test("visible focus", async ({ page }) => { await expectVisibleFocus(page, page.getByLabel("Title")); });
	test("dialog", async ({ page }) => {
		const opener = page.getByRole("button", { name: "About this list" });
		await opener.click();
		const dialog = page.getByRole("dialog", { name: "About" });
		await expectFocusTrapped(page, dialog);
		await expectEscapeCloses(page, dialog, { opener });
	});
	test("media", async ({ page }) => {
		const q = () => page.evaluate(() => [matchMedia("(prefers-reduced-motion: reduce)").matches, matchMedia("(prefers-contrast: more)").matches, matchMedia("(forced-colors: active)").matches]);
		await withMedia(page, { reducedMotion: "reduce", contrast: "more", forcedColors: "active" }, async () => { expect(await q()).toEqual([true, true, true]); });
		expect(await q()).toEqual([false, false, false]);
	});
	test("reflow", async ({ page }) => {
		const r = await expectReflow(page);
		expect(r.fixedFontSizes).toEqual([]);
	});
});

test.describe("broken", () => {
	test.beforeEach(async ({ page }) => { await page.goto("/a11y-broken"); });
	test("visible focus", async ({ page }) => { await expectVisibleFocus(page, page.getByRole("button", { name: "Open settings" })); });
	test("focus trap", async ({ page }) => {
		await page.getByRole("button", { name: "Open settings" }).click();
		await expectFocusTrapped(page, page.getByRole("dialog", { name: "Settings" }));
	});
	test("escape", async ({ page }) => {
		await page.getByRole("button", { name: "Open settings" }).click();
		await page.getByLabel("Setting", { exact: true }).focus();
		await expectEscapeCloses(page, page.getByRole("dialog", { name: "Settings" }));
	});
	test("reflow", async ({ page }) => { await expectReflow(page); });
});
`;

/** Runs Playwright in dir (async: the sample app's server lives in this process). */
function runPlaywright(dir, base) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(NM, "@playwright", "test", "cli.js"), "test"], { cwd: dir, env: { ...process.env, BASE: base, CI: "1" } });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (code) => resolve({ code, out }));
	});
}

/** Flattens the JSON report → {"good › tab order": {status, error, annotations}}. */
function results(report) {
	const out = {};
	const walk = (suite, names) => {
		for (const s of suite.suites || []) walk(s, s.title && !s.title.endsWith(".mjs") ? [...names, s.title] : names);
		for (const spec of suite.specs || []) {
			const t = spec.tests[0];
			const r = t.results.at(-1);
			out[[...names, spec.title].join(" › ")] = { status: r.status, error: (r.errors || []).map((e) => e.message).join("\n"), annotations: [...(t.annotations || []), ...(r.annotations || [])] };
		}
	};
	walk(report, []);
	return out;
}

test("a11y helpers: the good page passes, the broken fixture fails each check for its planted reason", { skip: NM ? false : "set A11Y_NODE_MODULES to a node_modules with @playwright/test (and run npx playwright install chromium)", timeout: 180_000 }, async () => {
	const { createApp } = await import("../../../examples/sample-app/server.mjs");
	const server = createServer(createApp());
	await new Promise((ok) => server.listen(0, ok));
	try {
		const dir = mkdtempSync(path.join(tmpdir(), "qa-a11y-"));
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "a11y-run", private: true })); // no "type": a CommonJS repo, the common case
		symlinkSync(NM, path.join(dir, "node_modules"));
		assert.equal(install(dir, ["a11y"]).ok, true);
		mkdirSync(path.join(dir, "tests", "a11y"), { recursive: true });
		writeFileSync(path.join(dir, "tests", "a11y", "sample.a11y.spec.mjs"), SPEC);
		writeFileSync(path.join(dir, "playwright.config.mjs"), `export default { testDir: "tests", workers: 2, expect: { timeout: 1500 }, use: { baseURL: process.env.BASE }, reporter: [["json", { outputFile: "results.json" }]] };\n`);
		const run = await runPlaywright(dir, `http://localhost:${server.address().port}`);
		const r = results(JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8")));
		const show = (k) => `${k}: ${JSON.stringify(r[k])}\n${run.out.slice(-1500)}`;

		for (const k of ["good › tab order", "good › visible focus", "good › dialog", "good › media", "good › reflow"]) assert.equal(r[k]?.status, "passed", show(k));
		assert.equal(r["good › wrong order is caught"]?.status, "failed");
		assert.match(r["good › wrong order is caught"].error, /tab order: element #2 is reached before element #1/);

		assert.equal(r["broken › visible focus"]?.status, "failed");
		assert.match(r["broken › visible focus"].error, /no visible focus indicator/);
		assert.equal(r["broken › focus trap"]?.status, "failed");
		assert.match(r["broken › focus trap"].error, /focus didn't move into the dialog/);
		assert.equal(r["broken › escape"]?.status, "failed");
		assert.match(r["broken › escape"].error, /Escape didn't close the dialog/);
		assert.equal(r["broken › reflow"]?.status, "failed");
		assert.match(r["broken › reflow"].error, /the page scrolls sideways/);
		const findings = r["broken › reflow"].annotations.filter((a) => a.type === "a11y-finding").map((a) => a.description);
		assert.ok(findings.some((f) => /fixed font size .*p\.fixed\.wide "Fixed-size text/.test(f)), `fixed px text reported as a finding: ${JSON.stringify(findings)}`);
		assert.equal(r["good › reflow"].annotations.filter((a) => a.type === "a11y-finding").length, 0, "no findings on the good page");
	} finally {
		server.close();
	}
});
