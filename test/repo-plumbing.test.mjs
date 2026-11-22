// Repo plumbing checks: every workflow action is pinned to a commit SHA, the root README's plugin table matches
// each plugin.json, and the docs site has a README and CHANGELOG page for every plugin with working links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOVED, rewriteLink, sitePages, usePages } from "../scripts/build-site.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const market = JSON.parse(readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));

test("every `uses:` in every workflow is pinned to a commit SHA (or a docker image digest, or a local action)", () => {
	const dir = path.join(ROOT, ".github", "workflows");
	const bad = [];
	for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
		for (const [i, line] of readFileSync(path.join(dir, f), "utf8").split("\n").entries()) {
			const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
			if (!m) continue;
			const ref = m[1];
			const ok = ref.startsWith("./") || /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(ref) || /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref);
			if (!ok) bad.push(`${f}:${i + 1} ${ref}`);
			else if (!ref.startsWith("./") && !ref.startsWith("docker://") && !/#\s*v\d/.test(line)) bad.push(`${f}:${i + 1} needs a "# vX.Y.Z" comment (Dependabot updates it)`);
		}
	}
	assert.deepEqual(bad, []);
});

test("the root README's plugin table lists every plugin at its plugin.json version", () => {
	const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
	for (const p of market.plugins) {
		const v = JSON.parse(readFileSync(path.join(ROOT, p.source, ".claude-plugin", "plugin.json"), "utf8")).version;
		const row = new RegExp(`^\\| \\[${p.name}\\]\\([^)]+\\) \\| ([^|]+) \\|`, "m").exec(readme);
		assert.ok(row, `README table has no row for ${p.name}`);
		assert.equal(row[1].trim(), v, `${p.name}: README says ${row[1].trim()}, plugin.json says ${v}`);
	}
});

test("docs site: README + CHANGELOG pages for every plugin, docs/ pages, unique names, old names redirected", () => {
	const pages = sitePages(ROOT);
	const files = pages.map((p) => p.file);
	assert.equal(new Set(files).size, files.length, "page names are unique");
	for (const p of market.plugins) {
		assert.ok(files.includes(`${p.name}.html`), `${p.name} README page`);
		assert.ok(files.includes(`${p.name}-changelog.html`), `${p.name} CHANGELOG page`);
	}
	assert.ok(files.includes("qa-worked-example.html"));
	assert.ok(files.includes("changelog-marketplace.html") && files.includes("plan.html") && files.includes("index.html"));
	for (const to of Object.values(MOVED)) assert.ok(files.includes(to), `redirect target ${to} exists`);
	for (const from of Object.keys(MOVED)) assert.ok(!files.includes(from), `${from} is only a redirect`);
	for (const p of pages) readFileSync(path.join(ROOT, p.source), "utf8"); // every source exists
});

test("docs site links: a link to another published page stays on the site; anything else goes to GitHub", () => {
	usePages(sitePages(ROOT));
	assert.equal(rewriteLink("plugins/qa/CHANGELOG.md", "CHANGELOG.md"), "qa-changelog.html");
	assert.equal(rewriteLink("../../README.md#plugins", "plugins/qa/README.md"), "index.html#plugins");
	assert.equal(rewriteLink("docs/worked-example.md", "plugins/qa/README.md"), "qa-worked-example.html");
	assert.match(rewriteLink("bin/qa-support", "plugins/qa/README.md"), /^https:\/\/github\.com\/.+\/blob\/main\/plugins\/qa\/bin\/qa-support$/);
	assert.equal(rewriteLink("https://example.com/x", "README.md"), "https://example.com/x");
});
