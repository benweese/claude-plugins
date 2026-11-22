// The qa plugin's commons templates must match the hashes recorded when they were generated from the pinned
// tag. A hand edit fails here; fix it by re-running: node scripts/sync-commons-templates.mjs
// (CI also re-runs the sync for the pinned tag and fails on any diff, which catches drift from the tag.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "qa", "templates", "commons");
const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const walk = (d, b = d) => readdirSync(d).flatMap((e) => (statSync(path.join(d, e)).isDirectory() ? walk(path.join(d, e), b) : [path.relative(b, path.join(d, e)).split(path.sep).join("/")]));

test(`templates come from one pinned tag (${m.tag})`, () => {
	assert.match(m.tag, /^v\d+\.\d+\.\d+$/);
	assert.equal(m.source, "@benweese/playwright-test-commons");
});

test("every template matches its recorded hash, and nothing is unlisted", () => {
	const onDisk = walk(dir).filter((f) => f !== "manifest.json").sort();
	assert.deepEqual(onDisk, Object.keys(m.files).sort(), "files on disk vs manifest");
	for (const [rel, f] of Object.entries(m.files)) {
		assert.equal(createHash("sha256").update(readFileSync(path.join(dir, rel), "utf8")).digest("hex"), f.sha256, `${rel} changed — re-run node scripts/sync-commons-templates.mjs`);
	}
});

test("check-test-ids stays in commons; ui and core bundles don't import each other", () => {
	assert.ok(!Object.keys(m.files).some((r) => /check-?test-?ids|tools\//i.test(r)));
	for (const [rel, f] of Object.entries(m.files)) {
		const text = readFileSync(path.join(dir, rel), "utf8");
		if (f.bundle === "core") assert.doesNotMatch(text, /from "\.\.?\/ui\//, rel);
		if (f.bundle === "ui") assert.doesNotMatch(text, /from "\.\.\/(api|helpers|validation)\//, rel);
	}
});
