// node:test: the privacy hook, /privacy-scan, the plain-git pre-commit scanner and the hook installer run the
// same way directly, through a symlinked file and through a symlinked folder (the entry-point check used to
// compare process.argv[1], which keeps the symlink, so they did nothing there); nothing runs after an error
// exit; the bin tool loads as an ES module without syntax detection; no entry point calls process.exit().
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const unix = process.platform !== "win32";
const EMAIL = ["pat.quill", "@", "brightmail", ".co"].join(""); // made up, built at run time

/** Ways to reach plugins/privacy/<folder>/<file>: directly, via a symlink to the file, via a symlink to the folder. */
function entryPoints(folder, file, t) {
	const direct = path.join(PLUGIN, folder, file);
	const fileLink = path.join(mkdtempSync(path.join(tmpdir(), "privacy-link-")), file);
	const dirLink = path.join(mkdtempSync(path.join(tmpdir(), "privacy-dirlink-")), folder);
	try {
		symlinkSync(direct, fileLink);
		symlinkSync(path.join(PLUGIN, folder), dirLink, "dir");
	} catch (e) {
		t.skip(`can't create a symlink here (${e.code})`);
		return null;
	}
	return { direct, "symlinked file": fileLink, "symlinked folder": path.join(dirLink, file) };
}

/** A repo with one commit, an optional .claude/privacy.json, and (optionally) a staged file with a made-up email. */
function repo(config, { stageEmail = false } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "privacy-entry-"));
	const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
	g("init", "-q", "-b", "main");
	g("config", "user.email", "t@example.invalid");
	g("config", "user.name", "T");
	writeFileSync(path.join(dir, "readme.md"), "hello\n");
	g("add", ".");
	g("commit", "-qm", "init");
	if (config !== undefined) {
		mkdirSync(path.join(dir, ".claude"), { recursive: true });
		writeFileSync(path.join(dir, ".claude", "privacy.json"), JSON.stringify(config));
	}
	if (stageEmail) {
		writeFileSync(path.join(dir, "a.txt"), `${EMAIL}\n`);
		g("add", "a.txt");
	}
	return dir;
}

const run = (file, { args = [], input, cwd, env = {}, nodeArgs = [] } = {}) =>
	spawnSync(process.execPath, [...nodeArgs, file, ...args], { input: input === undefined ? "" : JSON.stringify(input), cwd, encoding: "utf8", env: { ...process.env, ...env } });

test("commit hook: a staged email is still denied (exit 0 + deny JSON, one line), directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("scripts", "pre-bash.mjs", t);
	if (!ways) return;
	const dir = repo({ version: 1, commitHook: true }, { stageEmail: true });
	for (const [how, file] of Object.entries(ways)) {
		const r = run(file, { input: { cwd: dir, tool_name: "Bash", tool_input: { command: "git commit -m x" } }, env: { CLAUDE_PROJECT_DIR: dir } });
		assert.equal(r.status, 0, `${how}: ${r.stderr}`);
		const lines = r.stdout.split("\n").filter(Boolean);
		assert.equal(lines.length, 1, `${how}: ${JSON.stringify(r.stdout)}`);
		const out = JSON.parse(lines[0]).hookSpecificOutput;
		assert.equal(out.permissionDecision, "deny", how);
		assert.match(out.permissionDecisionReason, /a\.txt:1\s+email address/, how);
		assert.ok(!r.stdout.includes(EMAIL), `${how}: the value is never printed`);
	}
});

test("/privacy-scan: findings still exit 1 with the report, directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("scripts", "scan.mjs", t);
	if (!ways) return;
	const dir = repo({ version: 1 });
	mkdirSync(path.join(dir, "docs"));
	writeFileSync(path.join(dir, "docs", "a.md"), `mail ${EMAIL}\n`);
	for (const [how, file] of Object.entries(ways)) {
		const r = run(file, { args: ["docs"], cwd: dir, env: { CLAUDE_PROJECT_DIR: dir } });
		assert.equal(r.status, 1, `${how}: ${r.stderr}`);
		assert.match(r.stdout, /docs\/a\.md:1\s+email address/, how);
	}
});

test("/privacy-scan refresh: a failure prints one line and exits 2; nothing runs after it", { skip: !unix }, (t) => {
	const ways = entryPoints("scripts", "scan.mjs", t);
	if (!ways) return;
	const dir = repo({ version: 1, denylist: "gh:example-owner/example-repo/deny.txt" });
	const noGh = mkdtempSync(path.join(tmpdir(), "privacy-nopath-")); // PATH with no gh: refresh throws, no network
	for (const [how, file] of Object.entries(ways)) {
		const r = run(file, { args: ["refresh"], cwd: dir, env: { CLAUDE_PROJECT_DIR: dir, PATH: noGh } });
		assert.equal(r.status, 2, `${how}: ${r.stderr}`);
		assert.match(r.stdout, /^Refresh failed: gh couldn't read gh:example-owner\/example-repo\/deny\.txt: .*\n$/, how);
	}
});

test("plain-git scanner: blocks with exit 1; not opted in → exit 0 and nothing after the early return", { skip: !unix }, () => {
	const script = path.join(PLUGIN, "scripts", "git-pre-commit.mjs");
	const on = repo({ version: 1, commitHook: true }, { stageEmail: true });
	const blocked = run(script, { cwd: on });
	assert.equal(blocked.status, 1, blocked.stderr);
	assert.match(blocked.stderr, /privacy: commit blocked — .*\n.*a\.txt:1\s+email address/s);
	assert.ok(!blocked.stderr.includes(EMAIL));
	const off = repo({ version: 1, commitHook: false }, { stageEmail: true });
	const quiet = run(script, { cwd: off });
	assert.equal(quiet.status, 0, quiet.stderr);
	assert.equal(quiet.stdout + quiet.stderr, "", "returned before scanning");
});

test("hook installer: installs the same way directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("bin", "install-privacy-git-hook", t);
	if (!ways) return;
	for (const [how, file] of Object.entries(ways)) {
		const dir = repo({ version: 1, commitHook: true }); // it installs into the repo, so one per way
		const r = run(file, { cwd: dir });
		assert.equal(r.status, 0, `${how}: ${r.stdout}${r.stderr}`);
		assert.match(r.stdout, /^Installed: git will run \.git\/hooks\/pre-commit/, how);
		const again = run(file, { cwd: dir });
		assert.equal(again.status, 1, `${how}: refuses to overwrite`);
		assert.match(again.stdout, /already exists/, how);
	}
});

test("bin tool loads as an ES module without syntax detection (bin/package.json type: module)", () => {
	assert.deepEqual(JSON.parse(readFileSync(path.join(PLUGIN, "bin", "package.json"), "utf8")), { type: "module" });
	const r = run(path.join(PLUGIN, "bin", "install-privacy-git-hook"), { cwd: mkdtempSync(path.join(tmpdir(), "privacy-esm-")), nodeArgs: ["--no-experimental-detect-module"] });
	assert.doesNotMatch(r.stderr, /Failed to load the ES module|Cannot use import statement|SyntaxError/, r.stderr);
	assert.match(r.stdout, /Not inside a git repository/);
});

test("entry points: isMain(process.argv[1], import.meta.url), no process.exit(), no direct process.argv[1] comparison", () => {
	const files = [...readdirSync(path.join(PLUGIN, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => path.join("scripts", f)), path.join("bin", "install-privacy-git-hook")];
	for (const f of files) {
		const code = readFileSync(path.join(PLUGIN, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		assert.ok(!/process\.exit\(/.test(code), `${f}: uses process.exit(); set process.exitCode and return`);
		assert.ok(!/process\.argv\[1\]\s*===|===\s*path\.resolve\(process\.argv\[1\]\)/.test(code), `${f}: compares process.argv[1] directly; use isMain()`);
		if (/\bisMain\(/.test(code) && !f.endsWith("is-main.mjs")) assert.match(code, /if \(isMain\(process\.argv\[1\], import\.meta\.url\)\) (?:await )?main\(\);\s*$/, `${f}: entry line is the last statement`);
	}
});
