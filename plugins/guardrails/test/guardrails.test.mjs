// node:test for the guardrails hooks. Throwaway git repos; fake secrets are assembled at run time so no
// secret-looking string sits in this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, splitCommands } from "../scripts/lib.mjs";
import { ASK_SPLIT, ASK_UNRESOLVED, capFragment, commitPlans, dangerReasons, preBash, secretCheck } from "../scripts/pre-bash.mjs";
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
/** secretCheck's deny reason, or null (an "ask" fails the test that expects a deny). */
const denied = (...a) => {
	const r = secretCheck(...a);
	if (r && r.decision !== "deny") throw new Error(`expected deny or null, got ${r.decision}: ${r.reason}`);
	return r ? r.reason : null;
};

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
	const plan = (line) => commitPlans(line, { cwd: tmpdir() });
	assert.deepEqual(plan("git add . && git commit -m x"), [{ dir: tmpdir(), unresolved: null, all: false, addAll: true, addTracked: false, addPaths: [] }]);
	assert.equal(plan("git commit -am x")[0].all, true);
	assert.equal(plan("git commit --all -m x")[0].all, true);
	assert.equal(plan("git commit -m 'add all'")[0].all, false);
	assert.deepEqual(plan("git add src/a.js b.txt && git commit -m x")[0].addPaths, ["src/a.js", "b.txt"]);
	assert.deepEqual(plan("git status"), []);
});

test("secrets: a staged secret blocks the commit; a clean commit passes", () => {
	const r = repo();
	r.write("config.js", `const token = "${FAKE_GH}";\n`);
	r.g("add", "config.js");
	const reason = denied("git commit -m x", r.dir, builtIn);
	assert.match(reason, /config\.js:1\s+GitHub token\s+ghp_…\(40 chars\)/);
	assert.doesNotMatch(reason, new RegExp(FAKE_GH)); // masked
	const c = repo();
	c.write("ok.js", "export const y = 2;\n");
	c.g("add", "ok.js");
	assert.equal(denied("git commit -m x", c.dir, builtIn), null);
});

test('secrets: "git add . && git commit -m x" scans untracked files about to be added', () => {
	const r = repo();
	r.write("new/keys.txt", `aws = ${FAKE_AWS}\n`);
	assert.match(denied("git add . && git commit -m x", r.dir, builtIn), /new\/keys\.txt:1\s+AWS access key/);
	assert.equal(denied("git commit -m x", r.dir, builtIn), null, "not staged and not added → not committed");
	assert.equal(denied("git add app.js && git commit -m x", r.dir, builtIn), null, "a different path is added");
	assert.match(denied("git add new/keys.txt && git commit -m x", r.dir, builtIn), /AWS access key/);
});

test('secrets: "git commit -am x" scans tracked changes that aren\'t staged yet', () => {
	const r = repo();
	r.write("app.js", `export const x = 1;\nconst key = "${FAKE_GH}";\n`);
	assert.match(denied("git commit -am x", r.dir, builtIn), /app\.js:2\s+GitHub token/);
	assert.equal(denied("git commit -m x", r.dir, builtIn), null);
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
		assert.match(denied("git commit -m x", r.dir), /checked with gitleaks\)[\s\S]*config\.js:1\s+gitleaks github-pat/);
		writeFileSync(stub, `#!/bin/sh\n[ "$1" = version ] && exit 0\nexit 9\n`);
		assert.match(denied("git commit -m x", r.dir), /built-in patterns \(gitleaks failed to run\)[\s\S]*GitHub token/);
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
	r.write("src/x.js", "\n"); // `cd src` has to resolve for its relative target to be judged
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

// Each hook must block the same way when Claude Code runs it through a symlinked path (a symlinked script or a
// symlinked plugin folder). Before the fix, the entry-point check never matched there and the hook did nothing.
const SCRIPTS = path.join(HERE, "..", "scripts");

/** Ways to reach a script: directly, through a symlink to the file, through a symlink to the scripts/ folder. */
function entryPoints(script, t) {
	const direct = path.join(SCRIPTS, script);
	const fileLink = path.join(mkdtempSync(path.join(tmpdir(), "guardrails-link-")), script);
	const dirLink = path.join(mkdtempSync(path.join(tmpdir(), "guardrails-dirlink-")), "scripts");
	try {
		symlinkSync(direct, fileLink);
		symlinkSync(SCRIPTS, dirLink, "dir");
	} catch (e) {
		t.skip(`can't create a symlink here (${e.code})`);
		return null;
	}
	return { direct, "symlinked file": fileLink, "symlinked folder": path.join(dirLink, script) };
}

/** Runs a hook script the way Claude Code does: hook JSON on stdin, CLAUDE_PROJECT_DIR set, no gitleaks on PATH. */
const runHook = (file, input, dir) =>
	spawnSync(process.execPath, [file], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir, PATH: "/usr/bin:/bin" } });

/** stdout is exactly one JSON line denying the call (exit 0), nothing before or after it. */
function assertDeniedOnce(res, how, reason) {
	assert.equal(res.status, 0, `${how}: ${res.stderr}`);
	const lines = res.stdout.split("\n").filter(Boolean);
	assert.equal(lines.length, 1, `${how}: exactly one line of output, got ${JSON.stringify(res.stdout)}`);
	const out = JSON.parse(lines[0]).hookSpecificOutput;
	assert.equal(out.permissionDecision, "deny", how);
	assert.match(out.permissionDecisionReason, reason, how);
}

test("secret blocker: still denies (exit 0 + deny JSON) directly and through symlinks, and nothing runs after", { skip: !unix }, (t) => {
	const ways = entryPoints("pre-bash.mjs", t);
	if (!ways) return;
	// dangerousCommands is on and the line also runs `git reset --hard`: the deny must be the only output (no "ask").
	const r = repo({ config: { version: 1, dangerousCommands: true } });
	r.write("config.js", `const token = "${FAKE_GH}";\n`);
	r.g("add", "config.js");
	for (const [how, file] of Object.entries(ways)) {
		assertDeniedOnce(runHook(file, bash(r.dir, "git commit -m x && git reset --hard"), r.dir), how, /guardrails blocked this commit/);
	}
});

test("protected files: still denies (exit 0 + deny JSON) directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("protected-files.mjs", t);
	if (!ways) return;
	const r = repo({ config: { version: 1, protectedFiles: true } });
	const input = { cwd: r.dir, tool_name: "Read", tool_input: { file_path: path.join(r.dir, ".env") } };
	for (const [how, file] of Object.entries(ways)) assertDeniedOnce(runHook(file, input, r.dir), how, /\.env is a protected file/);
});

test("lint after edit: a lint failure still exits 2 with the report on stderr, directly and through symlinks", { skip: !unix }, (t) => {
	const ways = entryPoints("lint-after-edit.mjs", t);
	if (!ways) return;
	const r = repo({ config: { version: 1, lint: true, lintCommand: "node -e \"console.log('bad style in ' + process.argv[1]); process.exit(1)\" {file}" } });
	const input = { cwd: r.dir, tool_name: "Edit", tool_input: { file_path: path.join(r.dir, "app.js") } };
	for (const [how, file] of Object.entries(ways)) {
		const res = spawnSync(process.execPath, [file], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: r.dir } });
		assert.equal(res.status, 2, `${how}: ${res.stderr}`);
		assert.equal(res.stdout, "", how);
		assert.match(res.stderr, /^guardrails lint: app\.js \(\d+\.\ds\)\nbad style in app\.js\n$/, how);
	}
});

test("entry points: symlink-safe isMain(), no process.exit(), and finish() is always the last statement", () => {
	const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"));
	for (const f of files) {
		const src = readFileSync(path.join(SCRIPTS, f), "utf8");
		const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // comments may mention them
		assert.ok(!/process\.exit\(/.test(code), `${f}: uses process.exit(); set process.exitCode instead`);
		assert.ok(!/process\.argv\[1\]\s*===|===\s*path\.resolve\(process\.argv\[1\]\)/.test(code), `${f}: compares process.argv[1] directly; use isMain()`);
		const calls = src.split("\n").map((l, i) => ({ l, i })).filter(({ l }) => /\bfinish\(/.test(l) && !/export function finish/.test(l));
		if (!calls.length) continue;
		const lines = src.split("\n");
		const lastCode = lines.map((l, i) => ({ l: l.trim(), i })).filter(({ l }) => l && !l.startsWith("//")).pop();
		for (const { l, i } of calls) {
			assert.match(l, /^if \(isMain\(process\.argv\[1\], import\.meta\.url\)\) finish\(\w+\(await readInput\(\)\)\);$/, `${f}:${i + 1}: finish() must be called only from the isMain() entry line`);
			assert.equal(i, lastCode.i, `${f}:${i + 1}: code after finish() would still run (it sets process.exitCode, it doesn't exit)`);
		}
	}
	assert.ok(files.includes("is-main.mjs"), "the synced is-main.mjs copy is present");
});

// ---- #28: the repo each commit runs in, wrappers, "ask" when the repo can't be determined ----

/** A repo whose tracked app.js has an unstaged secret on line 2 (`git commit -am` picks it up). */
function secretRepo() {
	const r = repo();
	r.write("app.js", `export const x = 1;\nconst key = "${FAKE_GH}";\n`);
	return r;
}
const check = (line, cwd, extra = {}) => secretCheck(line, cwd, { ...builtIn, ...extra });

test("secrets: a commit in another repo is scanned there (cd, pushd, env -C, git -C, sudo -D)", () => {
	const here = repo();
	const other = secretRepo();
	for (const form of ["cd {d} && git commit -am x", "cd {d}; git commit -am x", "pushd {d} && git commit -am x", "env -C {d} git commit -am x", "env --chdir={d} git commit -am x", "env -iC {d} git commit -am x", "git -C {d} commit -am x", "sudo -D {d} git commit -am x", "sudo -nD {d} git commit -am x"]) {
		const r = check(form.replaceAll("{d}", other.dir), here.dir);
		assert.equal(r?.decision, "deny", form);
		assert.match(r.reason, /: app\.js:2\s+GitHub token/, `${form}: names the other repo's file`);
	}
	assert.equal(check(`cd ${here.dir} && git commit -am x`, other.dir), null, "cd into a clean repo → nothing to block");
});

test("secrets: indirect git invocations are scanned (env, command, \\git, /usr/bin/git, sudo, sudo -u, nested)", () => {
	const r = repo();
	r.write("config.js", `const token = "${FAKE_GH}";\n`);
	r.g("add", "config.js");
	for (const cmd of ["FOO=1 git commit -m x", "env git commit -m x", "env FOO=1 git commit -m x", "command git commit -m x", "\\git commit -m x", "/usr/bin/git commit -m x", "sudo git commit -m x", "sudo -u someone git commit -m x", "sudo -nu root git commit -m x", "sudo env git commit -m x"]) {
		assert.equal(check(cmd, r.dir)?.decision, "deny", cmd);
	}
	assert.equal(check("command -v git", r.dir), null);
});

test("secrets: a commit whose repo can't be determined → ask with the reason; the starting repo is never scanned instead", () => {
	const here = secretRepo(); // if the hook fell back to scanning here, these would be denies
	const forms = ['cd "$X" && git commit -am x', "cd $(git rev-parse --show-toplevel) && git commit -am x", 'cd "$(git rev-parse --show-toplevel)" && git commit -am x', "cd `pwd` && git commit -am x", "cd - && git commit -am x", "pushd +1 && git commit -am x", "pushd && git commit -am x", "popd && git commit -am x", "cd missing && git commit -am x", "pushd missing && git commit -am x", "env -C $X git commit -am x", "env -C missing git commit -am x", "git -C $X commit -am x", "git -C missing commit -am x", "sudo -D $X git commit -am x", "GIT_DIR=/x git commit -am x", "git --git-dir=/x commit -am x", "( cd src && git commit -am x )"];
	for (const form of forms) {
		const r = check(form, here.dir);
		assert.equal(r?.decision, "ask", form);
		assert.ok(r.reason.startsWith(`guardrails: ${ASK_UNRESOLVED} (`), `${form}: ${r.reason}`);
	}
});

test("secrets: env -S mentioning git → ask; without git → nothing", () => {
	const here = secretRepo();
	for (const form of ['env -S "git commit -am x"', 'env --split-string="git commit -am x"', 'env -iS "git commit -am x"']) {
		assert.deepEqual(check(form, here.dir), { decision: "ask", reason: `guardrails: ${ASK_SPLIT}.` }, form);
	}
	assert.equal(check('env -S "echo hi"', here.dir), null);
});

test("secrets: what can be resolved is — bare cd, ~, ~/x, relative after a cd, quoted paths with spaces", () => {
	const home = mkdtempSync(path.join(tmpdir(), "guardrails-home-"));
	const homeRepo = secretRepo();
	const spaced = path.join(home, "my repo");
	spawnSync("git", ["clone", "-q", homeRepo.dir, spaced]);
	writeFileSync(path.join(spaced, "app.js"), `export const x = 1;\nconst key = "${FAKE_GH}";\n`);
	const here = repo();
	const deny = (line, h = home) => check(line, here.dir, { home: h })?.decision;
	assert.equal(deny("cd && git commit -am x", homeRepo.dir), "deny", "bare cd → home");
	assert.equal(deny("cd ~ && git commit -am x", homeRepo.dir), "deny");
	assert.equal(deny('cd ~/"my repo" && git commit -am x'), "deny");
	assert.equal(deny(`cd "${spaced}" && git commit -am x`), "deny");
	assert.equal(deny(`cd ${home} && cd "my repo" && git commit -am x`), "deny", "relative to the tracked directory");
	assert.equal(deny(`cd '${home}' && git -C 'my repo' commit -am x`), "deny");
});

test("secrets: every commit in the line is checked; a deny wins over an ask; subshells restore the directory", () => {
	const here = repo();
	const other = secretRepo();
	assert.equal(check(`git commit -m a && cd ${other.dir} && git commit -am b`, here.dir)?.decision, "deny", "the second commit");
	assert.equal(check(`cd "$X" && git commit -m a; cd ${other.dir} && git commit -am b`, here.dir)?.decision, "deny");
	assert.equal(check(`( cd ${other.dir} && make ) && git commit -am x`, here.dir), null, "after ), back in the clean repo");
	assert.equal(check(`{ cd ${other.dir}; } && git commit -am x`, here.dir)?.decision, "deny", "{ … } keeps the cd");
	assert.equal(check("git -C . status && FOO=1 git status", here.dir), null);
});

test("dangerous: wrappers around rm are normalised; an unknown directory doesn't guess at relative targets", () => {
	const r = repo({ config: { version: 1, dangerousCommands: true } });
	const ask = (cmd) => dangerReasons(cmd, r.dir, r.dir);
	for (const c of ["sudo -u someone rm -rf /", "sudo -nu root rm -rf ~", "sudo -- rm -rf /", "/bin/rm -rf /", "\\rm -rf /", "env rm -rf /", "command rm -rf /", 'cd "$X" && rm -rf /', `cd "$X" && rm -rf ${r.dir}`]) assert.equal(ask(c).length, 1, c);
	assert.deepEqual(ask('cd "$X" && rm -rf ..'), [], "relative to a directory that can't be determined: not judged");
	assert.deepEqual(ask("sudo -u someone rm -rf node_modules"), []);
});

test("secrets: gitleaks findings point at the real file line, also across staged and unstaged changes", { skip: !unix }, () => {
	const r = repo();
	r.write("config.js", "// one\n// two\nconst a = null;\nconst b = null;\n");
	r.g("add", "config.js");
	r.g("commit", "-qm", "config");
	r.write("config.js", `// one\n// two\nconst a = "${FAKE_GH}";\nconst b = null;\n`);
	r.g("add", "config.js"); // staged: line 3
	r.write("config.js", `// one\n// two\nconst a = "${FAKE_GH}";\nconst b = "${FAKE_GH}";\n`); // unstaged: line 4
	const bin = mkdtempSync(path.join(tmpdir(), "fake-gitleaks-"));
	// Like real gitleaks: StartLine is the line in the file it was given.
	writeFileSync(path.join(bin, "gitleaks"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
if (a[0] === "version") process.exit(0);
const out = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else fs.readFileSync(p, "utf8").split("\\n").forEach((l, i) => { if (/gh[p]_[A-Za-z0-9]{36}/.test(l)) out.push({ File: p, StartLine: i + 1, RuleID: "github-pat" }); }); } })(a[1]);
fs.writeFileSync(a[a.indexOf("--report-path") + 1], JSON.stringify(out));
process.exit(out.length ? 3 : 0);
`);
	chmodSync(path.join(bin, "gitleaks"), 0o755);
	const old = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${old}`;
	try {
		const reason = denied("git commit -am x", r.dir, { gitleaks: true });
		assert.match(reason, /checked with gitleaks\)/);
		assert.match(reason, /config\.js:3\s+gitleaks github-pat/);
		assert.match(reason, /config\.js:4\s+gitleaks github-pat/);
		assert.doesNotMatch(reason, /config\.js:[12]\s/, "no temp-file line numbers");
	} finally {
		process.env.PATH = old;
	}
});

test("as a real hook: an unresolvable repo → exit 0 + one ask JSON line; a deny still denies", { skip: !unix }, () => {
	const r = secretRepo();
	const run = (command) => spawnSync(process.execPath, [path.join(HERE, "..", "scripts", "pre-bash.mjs")], { input: JSON.stringify(bash(r.dir, command)), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: r.dir, PATH: "/usr/bin:/bin" } });
	const asked = run('cd "$(git rev-parse --show-toplevel)" && git commit -am x');
	assert.equal(asked.status, 0);
	const lines = asked.stdout.split("\n").filter(Boolean);
	assert.equal(lines.length, 1);
	const out = JSON.parse(lines[0]).hookSpecificOutput;
	assert.equal(out.permissionDecision, "ask");
	assert.match(out.permissionDecisionReason, /^guardrails: can't tell which repo this commits in; secrets not checked \(\$\(git rev-parse --show-toplevel\) \(a variable or command substitution\)\)\. Run it anyway\?$/);
	assert.equal(JSON.parse(run("git commit -am x").stdout).hookSpecificOutput.permissionDecision, "deny");
	assert.equal(run("git commit -am x && env -S 'git status'").stdout.includes('"deny"'), true, "deny wins over the env -S ask");
});

test("preBash: a secret-check ask and dangerous-command reasons share one prompt", () => {
	const r = repo({ config: { version: 1, dangerousCommands: true } });
	const out = preBash(bash(r.dir, 'cd "$X" && git commit -am x && git reset --hard'), env(r.dir), builtIn).json.hookSpecificOutput;
	assert.equal(out.permissionDecision, "ask");
	assert.match(out.permissionDecisionReason, /^guardrails: can't tell which repo .*\. guardrails: git reset --hard discards uncommitted work\. Run it anyway\?$/);
});

test("ask reason: a long command fragment is cut to about 60 characters with …, the explanation kept whole", () => {
	const here = secretRepo();
	const long = `$(git -C ${"very/long/path/".repeat(8)} rev-parse --show-toplevel)`;
	const r = check(`cd "${long}" && git commit -am x`, here.dir);
	assert.equal(r?.decision, "ask");
	const m = /\(([^]*) \(a variable or command substitution\)\)\.$/.exec(r.reason);
	assert.ok(m, r.reason);
	assert.equal(m[1].length, 60);
	assert.ok(m[1].endsWith("…") && m[1].startsWith("$(git -C very/long/path/"), m[1]);
	assert.equal(capFragment("short (why)"), "short (why)");
	assert.equal(capFragment("x".repeat(61)), `${"x".repeat(59)}…`);
});

test("as a real hook: commits behind runners and keywords are denied; an unparsable commit asks", { skip: !unix }, () => {
	const r = repo();
	r.write("config.js", `const token = "${FAKE_GH}";\n`); // built at run time
	r.g("add", "config.js");
	const run = (command) => {
		const res = spawnSync(process.execPath, [path.join(HERE, "..", "scripts", "pre-bash.mjs")], { input: JSON.stringify(bash(r.dir, command)), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: r.dir, PATH: "/usr/bin:/bin" } });
		assert.equal(res.status, 0, `${command}: ${res.stderr}`);
		return JSON.parse(res.stdout).hookSpecificOutput;
	};
	for (const command of ["if true; then git commit -m x; fi", "! git commit -m x", "nohup git commit -m x", "timeout 5 git commit -m x", "nohup sudo env git commit -m x", "time nice -n 5 git commit -m x"]) {
		const out = run(command);
		assert.equal(out.permissionDecision, "deny", command);
		assert.match(out.permissionDecisionReason, /config\.js:1\s+GitHub token/, command);
	}
	for (const command of ["xargs git commit", "bash -c 'git commit -m x'", "eval git commit -m x"]) {
		const out = run(command);
		assert.equal(out.permissionDecision, "ask", command);
		assert.equal(out.permissionDecisionReason, "guardrails: can't parse this commit; secrets not checked. Run it anyway?", command);
	}
	assert.equal(spawnSync(process.execPath, [path.join(HERE, "..", "scripts", "pre-bash.mjs")], { input: JSON.stringify(bash(r.dir, 'echo "git commit"')), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: r.dir } }).stdout, "", "a quoted mention isn't a commit");
});
