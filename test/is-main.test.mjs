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

test("realpath throwing → falls back to comparing resolved paths (the old check), never a silent no-op", (t) => {
	const self = pathToFileURL(SOURCE).href;
	const throws = () => {
		const e = new Error("EACCES: permission denied");
		e.code = "EACCES";
		throw e;
	};
	assert.equal(isMain(SOURCE, self, throws), true, "the script's own path still matches");
	assert.equal(isMain(path.relative(process.cwd(), SOURCE), self, throws), true, "a relative argv[1] resolves to the same path");
	assert.equal(isMain(path.join(ROOT, "scripts", "sync-shared.mjs"), self, throws), false, "a different file doesn't");
	assert.equal(isMain(undefined, self, throws), false, "a missing argv[1] is still false");
	assert.equal(isMain(SOURCE, undefined, throws), false, "a missing selfUrl is still false");
	const link = linkTo(SOURCE, t);
	if (!link) return;
	assert.equal(isMain(link, self), true, "with a working realpath, a symlink matches");
	assert.equal(isMain(link, self, throws), false, "in the fallback, a symlinked path doesn't (the old limitation, only in this edge case)");
});

test("realpath throwing on only one side still falls back on both sides (no mixing of real and resolved paths)", (t) => {
	const self = pathToFileURL(SOURCE).href;
	const link = linkTo(SOURCE, t); // a real realpath would map this to SOURCE (→ true); the fallback must not
	if (!link) return;
	const throwsFor = (bad) => (p) => {
		if (p === bad) throw new Error("ENOENT");
		return p;
	};
	assert.equal(isMain(link, self, throwsFor(link)), false, "throws for argv[1]: plain resolved paths compared");
	assert.equal(isMain(link, self, throwsFor(SOURCE)), false, "throws for the script: plain resolved paths compared");
	assert.equal(isMain(SOURCE, self, throwsFor(SOURCE)), true, "the script's own path still matches");
});
