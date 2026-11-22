// node:test for scripts/release.mjs: CHANGELOG sections and which plugin versions still need a release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection, plan } from "../scripts/release.mjs";

const LOG = "# Changelog\n\nIntro.\n\n## [1.2.0] - 2026-11-21\n\n### Added\n\n- New thing.\n\n## [1.1.0] - 2026-11-20\n\n### Fixed\n\n- Old bug.\n";

test("changelogSection: the version's body up to the next ## heading; exact version only", () => {
	assert.equal(changelogSection(LOG, "1.2.0"), "### Added\n\n- New thing.");
	assert.equal(changelogSection(LOG, "1.1.0"), "### Fixed\n\n- Old bug.");
	assert.equal(changelogSection(LOG, "1.2"), null, "1.2 isn't 1.2.0");
	assert.equal(changelogSection(LOG, "9.9.9"), null);
	assert.equal(changelogSection("## [1.0.0]\n\n## [0.9.0]\n- x\n", "1.0.0"), null, "an empty section is missing");
});

function repo(plugins) {
	const dir = mkdtempSync(path.join(tmpdir(), "release-"));
	mkdirSync(path.join(dir, ".claude-plugin"));
	writeFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: plugins.map((p) => ({ name: p.name, source: `./plugins/${p.name}` })) }));
	for (const p of plugins) {
		mkdirSync(path.join(dir, "plugins", p.name, ".claude-plugin"), { recursive: true });
		writeFileSync(path.join(dir, "plugins", p.name, ".claude-plugin", "plugin.json"), JSON.stringify({ name: p.name, version: p.version }));
		writeFileSync(path.join(dir, "plugins", p.name, "CHANGELOG.md"), p.log);
	}
	return dir;
}

test("plan: only versions without a <plugin>-v<version> tag, with their notes", () => {
	const dir = repo([{ name: "qa", version: "1.2.0", log: LOG }, { name: "docs", version: "1.1.0", log: LOG }]);
	const todo = plan(dir, new Set(["docs-v1.1.0", "qa-v1.1.0"]));
	assert.deepEqual(todo, [{ name: "qa", version: "1.2.0", tag: "qa-v1.2.0", notes: "### Added\n\n- New thing." }]);
	assert.deepEqual(plan(dir, new Set(["qa-v1.2.0", "docs-v1.1.0"])), []);
});

test("plan: a version with no CHANGELOG section stops the release", () => {
	const dir = repo([{ name: "qa", version: "1.3.0", log: LOG }]);
	assert.throws(() => plan(dir, new Set()), /qa 1\.3\.0: no "## \[1\.3\.0\]" section in .*CHANGELOG\.md/);
});

test("every plugin in this repo has a CHANGELOG section for its current version", () => {
	const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
	assert.equal(plan(root, new Set()).length > 0, true);
});
