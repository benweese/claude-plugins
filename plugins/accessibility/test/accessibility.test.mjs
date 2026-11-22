// node:test for the accessibility plugin (no browser needed). The real axe scan is exercised against
// examples/sample-app's /a11y-broken fixture when A11Y_NODE_MODULES points at a node_modules with
// @playwright/test + @axe-core/playwright (skipped otherwise, and the skip is reported).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { axeTags, contrastRatio, contrastVerdict, formatViolations, loadA11yConfig, parseColor } from "../scripts/lib.mjs";
import { scan } from "../scripts/scan.mjs";
import { contrastReport } from "../bin/a11y-contrast";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function project(config) {
	const dir = mkdtempSync(path.join(tmpdir(), "a11y-"));
	writeFileSync(path.join(dir, "package.json"), '{"name":"x","type":"module"}');
	if (config !== undefined) {
		mkdirSync(path.join(dir, ".claude"));
		writeFileSync(path.join(dir, ".claude", "a11y.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	return dir;
}

test("contrast: known pairs, all color forms, AA vs AAA", () => {
	assert.equal(contrastRatio(parseColor("#000"), parseColor("#ffffff")).toFixed(2), "21.00");
	assert.equal(contrastRatio(parseColor("rgb(255, 255, 255)"), parseColor("#fff")).toFixed(2), "1.00");
	const faint = contrastRatio(parseColor("#9a9a9a"), parseColor("#ffffff"));
	assert.ok(faint > 2.7 && faint < 2.9, String(faint));
	assert.deepEqual(contrastVerdict(faint), { text: false, largeText: false, uiAndGraphics: false });
	const mid = contrastRatio(parseColor("#767676"), parseColor("#ffffff")); // the classic 4.54:1 gray
	assert.deepEqual(contrastVerdict(mid), { text: true, largeText: true, uiAndGraphics: true });
	assert.equal(contrastVerdict(mid, "AAA").text, false);
	assert.equal(parseColor("blue"), null);
	assert.equal(parseColor("rgb(300, 0, 0)"), null);
});

test("a11y-contrast output and exit codes", () => {
	const ok = contrastReport("#efece6", "#16181d");
	assert.equal(ok.code, 0);
	assert.match(ok.text, /^#efece6 on #16181d: 15\.\d\d:1 \(WCAG AA\)\n  normal text \(needs 4\.5:1\): pass/);
	assert.equal(contrastReport("#9a9a9a", "#fff").code, 1);
	assert.match(contrastReport("#9a9a9a", "#fff").text, /normal text \(needs 4\.5:1\): FAIL/);
	assert.equal(contrastReport("teal", "#fff").code, 2);
});

test("WCAG version + level → axe tags", () => {
	assert.deepEqual(axeTags("2.2", "AA"), ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]);
	assert.deepEqual(axeTags("2.0", "A"), ["wcag2a"]);
	assert.deepEqual(axeTags("2.1", "AAA"), ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag21aaa"]);
});

test("config: defaults, valid, invalid → defaults + warning", () => {
	assert.deepEqual(loadA11yConfig(project()), { level: "AA", wcag: "2.2", projectList: null, warning: null });
	const v = loadA11yConfig(project({ version: 1, level: "AAA", wcag: "2.1", projectList: "docs/a11y.md" }));
	assert.deepEqual([v.level, v.wcag, v.projectList], ["AAA", "2.1", "docs/a11y.md"]);
	const bad = loadA11yConfig(project("{nope"));
	assert.equal(bad.level, "AA");
	assert.match(bad.warning, /invalid/);
	assert.equal(loadA11yConfig(project({ version: 2, level: "AAA" })).level, "AA");
});

test("report: worst first, WCAG tags, element + why; none → 'no automated violations found'", () => {
	assert.equal(formatViolations({ violations: [] }), "No automated violations found.");
	const text = formatViolations({ violations: [
		{ id: "region", impact: "moderate", help: "Content should be in landmarks", tags: ["best-practice"], nodes: [{ target: ["p"], html: "<p>x</p>", failureSummary: "Fix: wrap it" }] },
		{ id: "label", impact: "critical", help: "Form elements must have labels", helpUrl: "https://dequeuniversity.com/rules/axe/4.10/label", tags: ["wcag2a", "wcag412"], nodes: [{ target: ["#title"], html: '<input id="title">', failureSummary: "Fix any of the following:\n  Element has no label" }] }
	] });
	assert.match(text, /^\[critical\] Form elements must have labels \(label; wcag2a, wcag412\)/);
	assert.match(text, /#title\n\s+<input id="title">\n\s+Fix any of the following: Element has no label/);
	assert.ok(text.indexOf("[critical]") < text.indexOf("[moderate]"));
});

test("no playwright / axe in the project → skipped (exit 3), with the install line; bad target → 2", async () => {
	const dir = project();
	const r = await scan(dir, "http://localhost:1/");
	assert.equal(r.code, 3);
	assert.match(r.text, /Scan skipped — playwright \(or @playwright\/test\) and @axe-core\/playwright isn't installed/);
	assert.match(r.text, /npm install --save-dev @playwright\/test @axe-core\/playwright/);
	assert.equal((await scan(dir, "")).code, 2);
});

const NM = process.env.A11Y_NODE_MODULES;
test("real scan of the broken fixture finds its problems; the real page has none", { skip: NM ? false : "set A11Y_NODE_MODULES to a node_modules with @playwright/test + @axe-core/playwright" }, async () => {
	const { createApp } = await import("../../../examples/sample-app/server.mjs");
	const server = createServer(createApp());
	await new Promise((ok) => server.listen(0, ok));
	try {
		const dir = project();
		symlinkSync(NM, path.join(dir, "node_modules"));
		const base = `http://localhost:${server.address().port}`;
		const broken = await scan(dir, `${base}/a11y-broken`);
		assert.equal(broken.code, 1, broken.text);
		const ids = broken.results.violations.map((v) => v.id);
		for (const id of ["html-has-lang", "image-alt", "color-contrast", "button-name"]) assert.ok(ids.includes(id), `${id} in ${ids}`);
		// axe accepts a placeholder as a label and can't see a clickable <div>: that's what the a11y-reviewer's
		// code review is for (both are planted in the fixture).
		assert.ok(!ids.includes("label"), "axe treats the placeholder as a name");
		assert.match(broken.text, /Automated checks find only part of WCAG/);
		const good = await scan(dir, `${base}/`);
		assert.equal(good.code, 0, good.text);
		assert.match(good.text, /No automated violations found\./);
	} finally {
		server.close();
	}
});
void HERE;
