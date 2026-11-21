// node:test for the guardrails hooks. Throwaway git repos; fake secrets are assembled at run time so no
// secret-looking string sits in this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, splitCommands } from "../scripts/lib.mjs";
import { commitPlan, dangerReasons, preBash, secretCheck } from "../scripts/pre-bash.mjs";
import { protectedFiles } from "../scripts/protected-files.mjs";
import { lintAfterEdit } from "../scripts/lint-after-edit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_GH = ["gh", "p_", "Xy7".repeat(12)].join(""); // GitHub-token shape, not a real token
const FAKE_AWS = ["AK", "IA", "Q2W3E4R5T6Y7U8I9"].join("");
const unix = process.platform !== "win32";

function repo({ config, defaultBranch = "trunk" } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "guardrails-"));
	const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
	g("init", "-q", "-b", defaultBranch);
	g("config", "user.email", "test@example.invalid");
	g("config", "user.name", "Test");
	g("config", "init.defaultBranch", defaultBranch);
	writeFileSync(path.join(dir, "app.js"), "export const x = 1;\n");
	g("add", ".");
	g("commit", "-qm", "init");
	if (config !== undefined) {
		mkdirSync(path.join(dir, ".claude"), { recursive: true });
		writeFileSync(path.join(dir, ".claude", "guardrails.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	return { dir, g, write: (f, s) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), s); } };
}
const bash = (dir, command) => ({ cwd: dir, tool_name: "Bash", tool_input: { command } });
const env = (dir, extra = {}) => ({ CLAUDE_PROJECT_DIR: dir, ...extra });
const builtIn = { gitleaks: false };

test("config: missing → secrets on, the rest off; invalid → secrets on + warning; env switch wins", () => {
	const none = repo();
	assert.deepEqual(loadConfig(none.dir, {}).on, { secrets: true, lint: false, protected: false, dangerous: false });
	const bad = repo({ config: "{oops" });
	const b = loadConfig(bad.dir, {});
	assert.equal(b.on.secrets, true);
	assert.match(b.warning, /invalid/);
	const v2 = repo({ config: { version: 2, dangerousCommands: true } });
	assert.equal(loadConfig(v2.dir, {}).on.dangerous, false);
	const all = repo({ config: { version: 1, secrets: false, lint: true, protectedFiles: true, dangerousCommands: true } });
	assert.deepEqual(loadConfig(all.dir, {}).on, { secrets: false, lint: true, protected: true, dangerous: true });
	assert.deepEqual(loadConfig(all.dir, { BENWEESE_GUARDRAILS_OFF: "lint, dangerous" }).on, { secrets: false, lint: false, protected: true, dangerous: false });
	assert.equal(loadConfig(none.dir, { BENWEESE_GUARDRAILS_OFF: "secrets" }).on.secrets, false);
});

test("splitting command lines and reading commit plans", () => {
	assert.deepEqual(splitCommands('git add . && git commit -m "a && b" ; echo hi | cat'), ["git add .", 'git commit -m "a && b"', "echo hi", "cat"]);
	assert.deepEqual(commitPlan("git add . && git commit -m x"), { commit: true, all: false, addAll: true, addTracked: false, addPaths: [] });
	assert.equal(commitPlan("git commit -am x").all, true);
	assert.equal(commitPlan("git commit --all -m x").all, true);
	assert.equal(commitPlan("git commit -m 'add all'").all, false);
	assert.deepEqual(commitPlan("git add src/a.js b.txt && git commit -m x").addPaths, ["src/a.js", "b.txt"]);
	assert.equal(commitPlan("git status").commit, false);
});

test("secrets: a staged secret blocks the commit; a clean commit passes", () => {
	const r = repo();
	r.write("config.js", `const token = "${FAKE_GH}";\n`);
	r.g("add", "config.js");
	const reason = secretCheck("git commit -m x", r.dir, builtIn);
	assert.match(reason, /config\.js:1\s+GitHub token\s+ghp_…\(40 chars\)/);
	assert.doesNotMatch(reason, new RegExp(FAKE_GH)); // masked
	const c = repo();
	c.write("ok.js", "export const y = 2;\n");
	c.g("add", "ok.js");
	assert.equal(secretCheck("git commit -m x", c.dir, builtIn), null);
});

test('secrets: "git add . && git commit -m x" scans untracked files about to be added', () => {
	const r = repo();
	r.write("new/keys.txt", `aws = ${FAKE_AWS}\n`);
	assert.match(secretCheck("git add . && git commit -m x", r.dir, builtIn), /new\/keys\.txt:1\s+AWS access key/);
	assert.equal(secretCheck("git commit -m x", r.dir, builtIn), null, "not staged and not added → not committed");
	assert.equal(secretCheck("git add app.js && git commit -m x", r.dir, builtIn), null, "a different path is added");
	assert.match(secretCheck("git add new/keys.txt && git commit -m x", r.dir, builtIn), /AWS access key/);
});

test('secrets: "git commit -am x" scans tracked changes that aren\'t staged yet', () => {
	const r = repo();
	r.write("app.js", `export const x = 1;\nconst key = "${FAKE_GH}";\n`);
	assert.match(secretCheck("git commit -am x", r.dir, builtIn), /app\.js:2\s+GitHub token/);
	assert.equal(secretCheck("git commit -m x", r.dir, builtIn), null);
});

test("secrets: gitleaks is used when installed; if it fails, the built-in patterns take over", { skip: !unix }, () => {
	const r = repo();
	r.write("config.js", `const token = "${FAKE_GH}";\n`);
	r.g("add", "config.js");
	const bin = mkdtempSync(path.join(tmpdir(), "fake-gitleaks-"));
	const stub = path.join(bin, "gitleaks");
	writeFileSync(stub, `#!/bin/sh\n[ "$1" = version ] && exit 0\nfor a; do [ "$prev" = --report-path ] && echo '[{"File":"'"$2"'/config.js","StartLine":1,"RuleID":"github-pat"}]' > "$a"; prev="$a"; done\nexit 3\n`);
	chmodSync(stub, 0o755);
	const old = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${old}`;
	try {
		assert.match(secretCheck("git commit -m x", r.dir), /checked with gitleaks\)[\s\S]*config\.js:1\s+gitleaks github-pat/);
		writeFileSync(stub, `#!/bin/sh\n[ "$1" = version ] && exit 0\nexit 9\n`);
		assert.match(secretCheck("git commit -m x", r.dir), /built-in patterns \(gitleaks failed to run\)[\s\S]*GitHub token/);
	} finally {
		process.env.PATH = old;
	}
});

test("secrets: off via config → the commit isn't checked; non-commit commands are ignored", () => {
	const r = repo({ config: { version: 1, secrets: false } });
	r.write("config.js", `const token = "${FAKE_GH}";\n`);
	r.g("add", "config.js");
	assert.equal(preBash(bash(r.dir, "git commit -m x"), env(r.dir), builtIn).json, undefined);
	const on = repo();
	on.write("config.js", `const token = "${FAKE_GH}";\n`);
	on.g("add", "config.js");
	assert.equal(preBash(bash(on.dir, "git commit -m x"), env(on.dir), builtIn).json.hookSpecificOutput.permissionDecision, "deny");
	assert.equal(preBash(bash(on.dir, "git status"), env(on.dir), builtIn).json, undefined);
});

test("dangerous commands → ask (opt-in); the default branch comes from git", () => {
	const r = repo({ config: { version: 1, dangerousCommands: true }, defaultBranch: "trunk" });
	const ask = (cmd) => dangerReasons(cmd, r.dir, r.dir);
	assert.match(ask("git push -f origin trunk")[0], /force-push to the default branch \(trunk\)/);
	assert.match(ask("git push --force-with-lease")[0], /trunk/, "no refspec → the current branch (trunk)");
	assert.match(ask("git push origin +trunk")[0], /trunk/);
	assert.deepEqual(ask("git push -f origin feature/x"), []);
	assert.deepEqual(ask("git push -f origin main"), [], "main isn't this repo's default branch");
	assert.deepEqual(ask("git push origin trunk"), []);
	assert.match(ask("git reset --hard HEAD~1")[0], /reset --hard/);
	for (const c of ["git clean -fd", "git clean -fdx", "git clean -f -d", "git clean -xdf"]) assert.equal(ask(c).length, 1, c);
	for (const c of ["git clean -n", "git clean -f"]) assert.deepEqual(ask(c), [], c);
	assert.equal(ask("git checkout -- .").length, 1);
	assert.equal(ask("git restore .").length, 1);
	assert.deepEqual(ask("git restore --staged ."), [], "only unstages");
	for (const c of ["rm -rf /", "rm -rf ~", "rm -rf $HOME", "rm -fr .", `rm -rf ${r.dir}`, "rm -Rf ./", "sudo rm -rf /*", "cd src && rm -rf .."]) assert.equal(ask(c).length, 1, c);
	for (const c of ["rm -rf node_modules", "rm -r .", "rm -f .env.bak", `rm -rf ${path.join(homedir(), "tmp-x")}`]) assert.deepEqual(ask(c), [], c);
	const out = preBash(bash(r.dir, "git reset --hard"), env(r.dir), builtIn).json.hookSpecificOutput;
	assert.equal(out.permissionDecision, "ask");
	const off = repo();
	assert.equal(preBash(bash(off.dir, "rm -rf /"), env(off.dir), builtIn).json, undefined, "off unless opted in");
});

test("protected files: blocked when opted in; .env.example etc. allowed; lists configurable", () => {
	const r = repo({ config: { version: 1, protectedFiles: true } });
	const deny = (f, tool = "Edit") => protectedFiles({ cwd: r.dir, tool_name: tool, tool_input: { file_path: path.join(r.dir, f) } }, env(r.dir)).json?.hookSpecificOutput?.permissionDecision;
	for (const f of [".env", ".env.local", "certs/server.pem", "deploy.key", "id_ed25519", "credentials.json"]) assert.equal(deny(f), "deny", f);
	assert.equal(deny(".env", "Read"), "deny");
	for (const f of [".env.example", ".env.sample", ".env.template", "src/app.ts", "README.md"]) assert.equal(deny(f), undefined, f);
	const custom = repo({ config: { version: 1, protectedFiles: true, protected: ["secrets/*"], allow: [] } });
	const cdeny = (f) => protectedFiles({ cwd: custom.dir, tool_name: "Write", tool_input: { file_path: f } }, env(custom.dir)).json?.hookSpecificOutput?.permissionDecision;
	assert.equal(cdeny("secrets/db.txt"), "deny");
	assert.equal(cdeny(".env"), undefined);
	const off = repo();
	assert.equal(protectedFiles({ cwd: off.dir, tool_name: "Edit", tool_input: { file_path: ".env" } }, env(off.dir)).json, undefined);
});

test("lint after edit (opt-in): lintCommand pass / fail, no linter → skipped, qa-covered files left to qa", () => {
	const pass = repo({ config: { version: 1, lint: true, lintCommand: "node -e \"process.exit(0)\" {file}" } });
	const input = (dir, f) => ({ cwd: dir, tool_name: "Edit", tool_input: { file_path: path.join(dir, f) } });
	assert.deepEqual(lintAfterEdit(input(pass.dir, "app.js"), env(pass.dir)), { exit: 0 });
	const fail = repo({ config: { version: 1, lint: true, lintCommand: "node -e \"console.log('bad style in ' + process.argv[1]); process.exit(1)\" {file}" } });
	const r = lintAfterEdit(input(fail.dir, "app.js"), env(fail.dir));
	assert.equal(r.exit, 2);
	assert.match(r.stderr, /^guardrails lint: app\.js \(\d+\.\ds\)\nbad style in app\.js/);
	const none = repo({ config: { version: 1, lint: true } });
	assert.match(lintAfterEdit(input(none.dir, "app.js"), env(none.dir)).json.systemMessage, /lint skipped/);
	assert.deepEqual(lintAfterEdit(input(none.dir, "notes.md"), env(none.dir)), { exit: 0 });
	writeFileSync(path.join(fail.dir, ".claude", "qa.json"), JSON.stringify({ version: 1, hooks: { lintAfterEdit: true } }));
	assert.deepEqual(lintAfterEdit(input(fail.dir, "tests/cart.spec.ts"), env(fail.dir)), { exit: 0 }, "qa's hook lints it");
	const off = repo();
	assert.deepEqual(lintAfterEdit(input(off.dir, "app.js"), env(off.dir)), { exit: 0 });
});

test("as real hooks: stdin JSON in, decision JSON out", { skip: !unix }, () => {
	const r = repo();
	r.write("config.js", `const token = "${FAKE_GH}";\n`);
	r.g("add", "config.js");
	const run = (script, input) => spawnSync(process.execPath, [path.join(HERE, "..", "scripts", script)], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: r.dir, PATH: "/usr/bin:/bin" } });
	const res = run("pre-bash.mjs", bash(r.dir, "git commit -m x"));
	assert.equal(res.status, 0);
	assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");
	const clean = run("pre-bash.mjs", bash(r.dir, "ls"));
	assert.equal(clean.stdout, "");
});
