// Real Playwright run of component tests against the sample app's story gallery (built-in `mount` fixture, no
// experimental package): the fixture's existing specs pass as written, and a spec in the shape the component-tester
// writes (the untested LoadFailed state + axe and keyboard checks on every state, via qa-support's ui and a11y
// copies) passes too. Runs only when A11Y_NODE_MODULES points at a node_modules with @playwright/test,
// @axe-core/playwright and a Chromium browser (CI sets it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install } from "../bin/qa-support";

const NM = process.env.A11Y_NODE_MODULES;
const SAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples", "sample-app");

const AGENT_SPEC = `import { test, expect } from "@playwright/test";
import { expectNoA11yViolations } from "../support/ui.js";
import { expectTabOrder, expectVisibleFocus } from "../support/a11y.js";

const STATES = ["Default", "Empty", "Loading", "LoadFailed", "Disabled"];

test.describe("BookList states: accessibility", () => {
	for (const state of STATES) {
		test(\`\${state}: no automated violations\`, async ({ mount, page }) => {
			await mount(\`BookList/\${state}\`);
			await expectNoA11yViolations(page);
		});
	}
});

test("LoadFailed: alert, Try again records retries, keyboard reachable with visible focus", async ({ mount, page }) => {
	const list = await mount("BookList/LoadFailed");
	await expect(list.getByRole("alert")).toHaveText("Couldn't load the books.");
	const retry = list.getByRole("button", { name: "Try again" });
	await retry.click();
	await retry.click();
	await expect(list.getByTestId("retries")).toHaveValue("2");
	await expectVisibleFocus(page, retry);
});

test("LoadFailed: a custom message comes through props", async ({ mount }) => {
	const list = await mount("BookList/LoadFailed", { error: "The server is down." });
	await expect(list.getByRole("alert")).toHaveText("The server is down.");
});

test("Default: Remove buttons in list order", async ({ mount, page }) => {
	const list = await mount("BookList/Default");
	await expectTabOrder(page, [list.getByRole("button", { name: "Remove The Quiet Lighthouse" }), list.getByRole("button", { name: "Remove Notes from a Small Orchard" })]);
});

test("an unknown story makes mount() throw", async ({ mount }) => {
	await expect(mount("BookList/Nope")).rejects.toThrow(/Unknown story: BookList\\/Nope/);
});
`;

function runPlaywright(dir) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(NM, "@playwright", "test", "cli.js"), "test"], { cwd: dir, env: { ...process.env, CI: "1" } });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (code) => resolve({ code, out }));
	});
}

function results(report) {
	const out = {};
	const walk = (suite, names) => {
		for (const s of suite.suites || []) walk(s, s.title && !/\.(spec|test)\.\w+$/.test(s.title) ? [...names, s.title] : names);
		for (const spec of suite.specs || []) {
			const r = spec.tests[0].results.at(-1);
			out[[...names, spec.title].join(" › ")] = { status: r.status, error: (r.errors || []).map((e) => e.message).join("\n") };
		}
	};
	walk(report, []);
	return out;
}

test("component tests run through Playwright's built-in mount against the sample gallery", { skip: NM ? false : "set A11Y_NODE_MODULES to a node_modules with @playwright/test + @axe-core/playwright (and npx playwright install chromium)", timeout: 180_000 }, async () => {
	const { createApp } = await import("../../../examples/sample-app/server.mjs");
	const server = createServer(createApp());
	await new Promise((ok) => server.listen(0, ok));
	try {
		const dir = mkdtempSync(path.join(tmpdir(), "qa-components-run-"));
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "components-run", private: true }));
		symlinkSync(NM, path.join(dir, "node_modules"));
		cpSync(path.join(SAMPLE, "fixtures", "components", "tests"), path.join(dir, "tests"), { recursive: true });
		assert.equal(install(dir, ["ui", "a11y"]).ok, true);
		mkdirSync(path.join(dir, "tests", "components"), { recursive: true });
		writeFileSync(path.join(dir, "tests", "components", "book-list.a11y.spec.mjs"), AGENT_SPEC);
		const base = `http://localhost:${server.address().port}`;
		writeFileSync(path.join(dir, "playwright.config.mjs"), `export default { testDir: "tests", workers: 2, expect: { timeout: 2000 }, use: { baseURL: "${base}/playwright/gallery/index.html", serviceWorkers: "block" }, reporter: [["json", { outputFile: "results.json" }]] };\n`);
		const run = await runPlaywright(dir);
		const r = results(JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8")));
		const failed = Object.entries(r).filter(([, v]) => v.status !== "passed");
		assert.deepEqual(failed, [], `${JSON.stringify(failed, null, 1)}\n${run.out.slice(-1500)}`);
		const titles = Object.keys(r);
		for (const t of ["#0201 | lists the books and records a removal @component", "#0204 | disables Remove @component", "#0205 | adds a book then removes it @component"]) assert.ok(titles.includes(t), `${t} ran`);
		for (const s of ["Default", "Empty", "Loading", "LoadFailed", "Disabled"]) assert.ok(titles.includes(`BookList states: accessibility › ${s}: no automated violations`), `${s} scanned`);
		assert.equal(titles.length, 14);
	} finally {
		server.close();
	}
});
