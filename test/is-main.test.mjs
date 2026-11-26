// node:test for shared/is-main.mjs: run directly, through a symlink, imported (not run), and bad arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMain } from "../shared/is-main.mjs";
import { COPIES } from "../scripts/sync-shared.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "shared", "is-main.mjs");

/** A temp folder with a copy of is-main.mjs, a script that prints "main" when it's the entry point, and one that imports it. */
function fixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "is-main-"));
	copyFileSync(SOURCE, path.join(dir, "is-main.mjs"));
	writeFileSync(path.join(dir, "tool.mjs"), 'import { isMain } from "./is-main.mjs";\nexport const x = 1;\nif (isMain(process.argv[1], import.meta.url)) console.log("main");\n');
	writeFileSync(path.join(dir, "importer.mjs"), 'import "./tool.mjs";\nconsole.log("importer");\n');
	return dir;
}

const node = (file) => spawnSync(process.execPath, [file], { encoding: "utf8" });

/** A symlink to `target` in a new folder, or null where symlinks can't be made. */
function linkTo(target, t) {
	const link = path.join(mkdtempSync(path.join(tmpdir(), "is-main-link-")), path.basename(target));
	try {
		symlinkSync(target, link);
		return link;
	} catch (e) {
		t.skip(`can't create a symlink here (${e.code})`);
		return null;
	}
}

test("run directly → main", () => {
	const r = node(path.join(fixture(), "tool.mjs"));
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "main\n");
});

test("run through a symlink → still main", (t) => {
	const link = linkTo(path.join(fixture(), "tool.mjs"), t);
	if (!link) return;
	const r = node(link);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "main\n");
});

test("imported by another script → not main", () => {
	const r = node(path.join(fixture(), "importer.mjs"));
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "importer\n");
});

test("false for a missing argv[1], a missing selfUrl, a path that doesn't exist, or a different file", () => {
	const self = pathToFileURL(SOURCE).href;
	assert.equal(isMain(undefined, self), false);
	assert.equal(isMain("", self), false);
	assert.equal(isMain(SOURCE, undefined), false, "no default selfUrl: it would be is-main.mjs's own URL");
	assert.equal(isMain(SOURCE), false);
	assert.equal(isMain(path.join(tmpdir(), "no-such-dir-is-main", "x.mjs"), self), false);
	assert.equal(isMain(path.join(ROOT, "scripts", "sync-shared.mjs"), self), false);
	assert.equal(isMain(SOURCE, self), true);
});

test("is-main.mjs is registered in sync-shared COPIES", () => {
	assert.ok(Array.isArray(COPIES["shared/is-main.mjs"]));
});
