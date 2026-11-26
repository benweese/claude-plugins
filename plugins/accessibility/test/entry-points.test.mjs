// node:test: the /a11y scan script and a11y-contrast run the same way directly, through a symlinked file and
// through a symlinked folder (the entry-point check used to compare process.argv[1], which keeps the symlink, so
// they did nothing there); nothing runs after the usage error; the bin tool loads as an ES module without syntax
// detection; no entry point calls process.exit().
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const unix = process.platform !== "win32";

/** Ways to reach plugins/accessibility/<folder>/<file>: directly, via a symlink to the file, via a symlink to the folder. */
function entryPoints(folder, file, t) {
	const direct = path.join(PLUGIN, folder, file);
	const fileLink = path.join(mkdtempSync(path.join(tmpdir(), "a11y-link-")), file);
	const dirLink = path.join(mkdtempSync(path.join(tmpdir(), "a11y-dirlink-")), folder);
	try {
		symlinkSync(direct, fileLink);
		symlinkSync(path.join(PLUGIN, folder), dirLink, "dir");
	} catch (e) {
		t.skip(`can't create a symlink here (${e.code})`);
		return null;
	}
	return { direct, "symlinked file": fileLink, "symlinked folder": path.join(dirLink, file) };
}

const run = (file, { args = [], cwd, env = {}, nodeArgs = [] } = {}) =>
	spawnSync(process.execPath, [...nodeArgs, file, ...args], { input: "", cwd, encoding: "utf8", env: { ...process.env, ...env } });

test("a11y-contrast: same report and exit code directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("bin", "a11y-contrast", t);
	if (!ways) return;
	for (const [how, file] of Object.entries(ways)) {
		const pass = run(file, { args: ["#000", "#fff"] });
		assert.equal(pass.status, 0, `${how}: ${pass.stderr}`);
		assert.match(pass.stdout, /^#000 on #fff: 21\.00:1 \(WCAG AA\)\n/, how);
		const fail = run(file, { args: ["#777", "#888"] });
		assert.equal(fail.status, 1, how);
		assert.match(fail.stdout, /normal text \(needs 4\.5:1\): FAIL/, how);
	}
});

test("a11y-contrast: no colours → only the usage line and exit 2; nothing runs after it", { skip: !unix }, (t) => {
	const ways = entryPoints("bin", "a11y-contrast", t);
	if (!ways) return;
	for (const [how, file] of Object.entries(ways)) {
		const r = run(file);
		assert.equal(r.status, 2, how);
		assert.equal(r.stdout, "usage: a11y-contrast <foreground> <background> [AA|AAA]\n", `${how}: no "Couldn't read undefined" after the usage line`);
		assert.equal(r.stderr, "", how);
	}
});

test("/a11y scan script: same message and exit code directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("scripts", "scan.mjs", t);
	if (!ways) return;
	const dir = mkdtempSync(path.join(tmpdir(), "a11y-entry-")); // no Playwright here: deterministic answers
	for (const [how, file] of Object.entries(ways)) {
		const none = run(file, { cwd: dir, env: { CLAUDE_PROJECT_DIR: dir } });
		assert.equal(none.status, 2, how);
		assert.equal(none.stdout, "Give a URL (http://localhost:3000/page) or an HTML file to scan.\n", how);
		const skipped = run(file, { args: ["index.html"], cwd: dir, env: { CLAUDE_PROJECT_DIR: dir } });
		assert.equal(skipped.status, 3, how);
		assert.match(skipped.stdout, /^Scan skipped — .* isn't installed in this project/, how);
	}
});

test("bin tool loads as an ES module without syntax detection (bin/package.json type: module)", () => {
	assert.deepEqual(JSON.parse(readFileSync(path.join(PLUGIN, "bin", "package.json"), "utf8")), { type: "module" });
	const r = run(path.join(PLUGIN, "bin", "a11y-contrast"), { args: ["#000", "#fff"], nodeArgs: ["--no-experimental-detect-module"] });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /21\.00:1/);
});

test("entry points: isMain(process.argv[1], import.meta.url), no process.exit(), no direct process.argv[1] comparison", () => {
	const files = [...readdirSync(path.join(PLUGIN, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => path.join("scripts", f)), path.join("bin", "a11y-contrast")];
	for (const f of files) {
		const code = readFileSync(path.join(PLUGIN, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		assert.ok(!/process\.exit\(/.test(code), `${f}: uses process.exit(); set process.exitCode and return`);
		assert.ok(!/process\.argv\[1\]\s*===|===\s*path\.resolve\(process\.argv\[1\]\)/.test(code), `${f}: compares process.argv[1] directly; use isMain()`);
		if (/\bisMain\(/.test(code) && !f.endsWith("is-main.mjs")) assert.match(code, /if \(isMain\(process\.argv\[1\], import\.meta\.url\)\) (?:await )?main\(\);\s*$/, `${f}: entry line is the last statement`);
	}
});
