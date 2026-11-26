// node:test: the qa hooks and bin tools run the same way directly, through a symlinked file and through a
// symlinked folder (the entry-point check used to compare process.argv[1], which keeps the symlink, so they did
// nothing there); the bin tools load as ES modules without Node's syntax detection; and no entry point calls
// process.exit() or compares process.argv[1] directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveRequirements } from "../scripts/requirements.mjs";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const unix = process.platform !== "win32";
const BIN_TOOLS = ["qa-support", "qa-requirements", "qa-components"];

/** Ways to reach plugins/qa/<folder>/<file>: directly, via a symlink to the file, via a symlink to the folder. */
function entryPoints(folder, file, t) {
	const direct = path.join(PLUGIN, folder, file);
	const fileLink = path.join(mkdtempSync(path.join(tmpdir(), "qa-link-")), file);
	const dirLink = path.join(mkdtempSync(path.join(tmpdir(), "qa-dirlink-")), folder);
	try {
		symlinkSync(direct, fileLink);
		symlinkSync(path.join(PLUGIN, folder), dirLink, "dir");
	} catch (e) {
		t.skip(`can't create a symlink here (${e.code})`);
		return null;
	}
	return { direct, "symlinked file": fileLink, "symlinked folder": path.join(dirLink, file) };
}

const run = (file, { args = [], input, cwd, env = {}, nodeArgs = [] } = {}) =>
	spawnSync(process.execPath, [...nodeArgs, file, ...args], { input: input === undefined ? "" : JSON.stringify(input), cwd, encoding: "utf8", env: { ...process.env, ...env } });

/** A project for test-file-check: qa.json opted in, a Playwright config, fake eslint/playwright bins with exit codes. */
function hookProject(bins) {
	const dir = mkdtempSync(path.join(tmpdir(), "qa-entry-"));
	mkdirSync(path.join(dir, ".claude"));
	writeFileSync(path.join(dir, ".claude", "qa.json"), JSON.stringify({ version: 1, hooks: { lintAfterEdit: true, autoReview: true } }));
	mkdirSync(path.join(dir, "tests"));
	writeFileSync(path.join(dir, "playwright.config.ts"), "export default {};\n");
	writeFileSync(path.join(dir, "tests", "cart.spec.ts"), "// test\n");
	mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
	for (const [name, code] of Object.entries(bins)) {
		const bin = path.join(dir, "node_modules", ".bin", name);
		writeFileSync(bin, `#!/bin/sh\n${code ? `echo "${name} found a problem"; exit ${code}` : "exit 0"}\n`);
		chmodSync(bin, 0o755);
	}
	return dir;
}

test("test-file-check: a failing check still exits 2 with the report on stderr, directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("scripts", "test-file-check.mjs", t);
	if (!ways) return;
	const dir = hookProject({ eslint: 2, playwright: 0 });
	const input = { cwd: dir, tool_name: "Edit", tool_input: { file_path: path.join(dir, "tests", "cart.spec.ts") } };
	for (const [how, file] of Object.entries(ways)) {
		const r = run(file, { input, env: { CLAUDE_PROJECT_DIR: dir } });
		assert.equal(r.status, 2, `${how}: ${r.stderr}`);
		assert.equal(r.stdout, "", how);
		assert.match(r.stderr, /^qa hook: tests\/cart\.spec\.ts .*\n✗ eslint\neslint found a problem/, how);
	}
});

test("test-file-check: passing checks still print the note, directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("scripts", "test-file-check.mjs", t);
	if (!ways) return;
	const dir = hookProject({ eslint: 0, playwright: 0 });
	const input = { cwd: dir, tool_name: "Edit", tool_input: { file_path: path.join(dir, "tests", "cart.spec.ts") } };
	for (const [how, file] of Object.entries(ways)) {
		const r = run(file, { input, env: { CLAUDE_PROJECT_DIR: dir } });
		assert.equal(r.status, 0, `${how}: ${r.stderr}`);
		assert.match(JSON.parse(r.stdout).systemMessage, /lint \+ --list OK/, how);
	}
});

test("review-guard: still reports on a green run, directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("scripts", "review-guard.mjs", t);
	if (!ways) return;
	// A saved requirement from another branch: the hook says so every time and writes no state, so each run matches.
	const dir = hookProject({});
	const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
	g("init", "-q", "-b", "main");
	g("config", "user.email", "test@example.invalid");
	g("config", "user.name", "Test");
	writeFileSync(path.join(dir, ".gitignore"), ".claude/qa/\nnode_modules/\n");
	g("add", ".");
	g("commit", "-qm", "init");
	saveRequirements(dir, { source: "issue", ref: "1", text: "made-up requirement" });
	g("switch", "-qc", "other");
	const input = { cwd: dir, tool_name: "Bash", tool_input: { command: "npx playwright test" }, tool_response: { stdout: "  4 passed (2.1s)", stderr: "", interrupted: false } };
	for (const [how, file] of Object.entries(ways)) {
		const r = run(file, { input, env: { CLAUDE_PROJECT_DIR: dir } });
		assert.equal(r.status, 0, `${how}: ${r.stderr}`);
		assert.match(JSON.parse(r.stdout).systemMessage, /saved requirement is from branch "main" \(you're on "other"\)/, how);
	}
});

test("bin tools: same output and exit code directly and through symlinks, including error exits", { skip: !unix }, (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "qa-bin-"));
	spawnSync("git", ["init", "-q"], { cwd });
	const cases = [
		{ tool: "qa-components", args: ["detect"], status: 0, stdout: /No component-test runner found/ },
		{ tool: "qa-requirements", args: [], status: 2, stderr: /^usage: qa-requirements save chat\|issue <n>\|file <path> \| show \| reviewed\n$/ },
		{ tool: "qa-support", args: ["plan", "--bundle", "a11y,extra"], status: 2, stderr: /^--bundle must be one or more of core, ui, a11y/ }
	];
	for (const c of cases) {
		const ways = entryPoints("bin", c.tool, t);
		if (!ways) return;
		for (const [how, file] of Object.entries(ways)) {
			const r = run(file, { args: c.args, cwd });
			const label = `${c.tool} ${c.args.join(" ")} (${how})`;
			assert.equal(r.status, c.status, `${label}: ${r.stderr}`);
			if (c.stdout) assert.match(r.stdout, c.stdout, label);
			if (c.stderr) {
				assert.match(r.stderr, c.stderr, label);
				assert.equal(r.stdout, "", `${label}: nothing runs after the error`);
			}
		}
	}
});

test("bin tools load as ES modules without syntax detection (bin/package.json type: module)", () => {
	assert.deepEqual(JSON.parse(readFileSync(path.join(PLUGIN, "bin", "package.json"), "utf8")), { type: "module" });
	const cwd = mkdtempSync(path.join(tmpdir(), "qa-esm-"));
	for (const tool of BIN_TOOLS) {
		const src = readFileSync(path.join(PLUGIN, "bin", tool), "utf8");
		assert.match(src, /^import .* from /m, `${tool} is ESM`);
		const r = run(path.join(PLUGIN, "bin", tool), { args: ["--no-such-command"], cwd, nodeArgs: ["--no-experimental-detect-module"] });
		assert.doesNotMatch(r.stderr, /Failed to load the ES module|Cannot use import statement|SyntaxError/, `${tool}: ${r.stderr}`);
	}
});

test("entry points: isMain(process.argv[1], import.meta.url), no process.exit(), no direct process.argv[1] comparison", () => {
	const files = [...readdirSync(path.join(PLUGIN, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => path.join("scripts", f)), ...BIN_TOOLS.map((f) => path.join("bin", f))];
	for (const f of files) {
		const code = readFileSync(path.join(PLUGIN, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		assert.ok(!/process\.exit\(/.test(code), `${f}: uses process.exit(); set process.exitCode and return`);
		assert.ok(!/process\.argv\[1\]\s*===|===\s*path\.resolve\(process\.argv\[1\]\)/.test(code), `${f}: compares process.argv[1] directly; use isMain()`);
		if (/\bisMain\(/.test(code) && !f.endsWith("is-main.mjs")) assert.match(code, /if \(isMain\(process\.argv\[1\], import\.meta\.url\)\) await main\(\);\s*$/, `${f}: entry line is the last statement`);
	}
});
