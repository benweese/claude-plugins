// node:test for the workflow SessionStart hook (scripts/principles.mjs). Throwaway project folders only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RULES, isMain, principles, readConfig, rulesText } from "../scripts/principles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, "..");
const SCRIPT = path.join(PLUGIN, "scripts", "principles.mjs");

/** A temp project; config: undefined = no file, string = raw text, object = JSON. */
function project(config) {
	const dir = mkdtempSync(path.join(tmpdir(), "workflow-"));
	if (config !== undefined) {
		mkdirSync(path.join(dir, ".claude"), { recursive: true });
		writeFileSync(path.join(dir, ".claude", "workflow.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	return dir;
}

/** Runs the real hook script the way Claude Code does: hook JSON on stdin, CLAUDE_PROJECT_DIR set. */
function run(dir) {
	const r = spawnSync(process.execPath, [SCRIPT], {
		input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: dir }),
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
		encoding: "utf8"
	});
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** stdout is exactly one JSON object with only a systemMessage that names the reason. */
function assertWarningOnly(stdout, reason) {
	const out = JSON.parse(stdout);
	assert.deepEqual(Object.keys(out), ["systemMessage"]);
	assert.match(out.systemMessage, /^workflow: \.claude\/workflow\.json is invalid \(.+\), session rules are off$/);
	assert.ok(out.systemMessage.includes(reason), out.systemMessage);
	assert.ok(!stdout.includes(RULES[0]), "no rules in the output");
}

test("missing config → empty stdout, exit 0", () => {
	const r = run(project());
	assert.equal(r.code, 0);
	assert.equal(r.stdout, "");
});

test("on → the rules print as plain text, exit 0", () => {
	const r = run(project({ version: 1, principles: true }));
	assert.equal(r.code, 0);
	assert.equal(r.stdout, `${rulesText()}\n`);
	assert.throws(() => JSON.parse(r.stdout), "plain text, not hook JSON");
});

test("valid config + an unknown key → the rules still print", () => {
	const r = run(project({ version: 1, principles: true, gate: "npm test", somethingNew: { a: 1 } }));
	assert.equal(r.code, 0);
	assert.equal(r.stdout, `${rulesText()}\n`);
});

test("invalid JSON → systemMessage only, exit 0", () => {
	const r = run(project("{ not json"));
	assert.equal(r.code, 0);
	assertWarningOnly(r.stdout, "not valid JSON");
});

test("wrong version → systemMessage only, exit 0", () => {
	for (const version of [2, "1", undefined]) {
		const r = run(project({ version, principles: true }));
		assert.equal(r.code, 0);
		assertWarningOnly(r.stdout, '"version": 1');
	}
});

test("not a JSON object → systemMessage only", () => {
	for (const raw of ["[]", "null", "1", '"x"']) assertWarningOnly(principles({}, { CLAUDE_PROJECT_DIR: project(raw) }).stdout, "not a JSON object");
});

test("unreadable config (a folder) → systemMessage only", () => {
	const dir = project();
	mkdirSync(path.join(dir, ".claude", "workflow.json"), { recursive: true });
	assertWarningOnly(principles({}, { CLAUDE_PROJECT_DIR: dir }).stdout, "can't be read");
});

test("principles: true → rules; false or absent → nothing, no warning", () => {
	assert.equal(principles({}, { CLAUDE_PROJECT_DIR: project({ version: 1, principles: true }) }).stdout, rulesText());
	for (const cfg of [{ version: 1, principles: false }, { version: 1 }]) {
		const dir = project(cfg);
		assert.deepEqual(readConfig(dir), { state: "ok", principles: false });
		assert.equal(principles({}, { CLAUDE_PROJECT_DIR: dir }).stdout, "");
	}
});

test('principles not a boolean ("true", 1, "yes", null) → systemMessage only', () => {
	for (const value of ["true", 1, "yes", null]) {
		const dir = project({ version: 1, principles: value });
		assert.deepEqual(readConfig(dir), { state: "invalid", reason: "principles must be true or false" });
		assertWarningOnly(principles({}, { CLAUDE_PROJECT_DIR: dir }).stdout, "principles must be true or false");
	}
});

test("a config saved with a leading BOM still turns the rules on", () => {
	const r = run(project(`\uFEFF${JSON.stringify({ version: 1, principles: true })}`));
	assert.equal(r.code, 0);
	assert.equal(r.stdout, `${rulesText()}\n`);
});

test("run through a symlink to the script → the rules still print", (t) => {
	const linkDir = mkdtempSync(path.join(tmpdir(), "workflow-link-"));
	const link = path.join(linkDir, "principles.mjs");
	try {
		symlinkSync(SCRIPT, link);
	} catch (e) {
		t.skip(`can't create a symlink here (${e.code})`);
		return;
	}
	const dir = project({ version: 1, principles: true });
	const r = spawnSync(process.execPath, [link], {
		input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: dir }),
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
		encoding: "utf8"
	});
	assert.equal(r.status, 0);
	assert.equal(r.stdout, `${rulesText()}\n`);
});

test("isMain(): false for an undefined argv[1] and for a path that doesn't exist; true for the script", () => {
	const self = pathToFileURL(SCRIPT).href;
	assert.equal(isMain(undefined, self), false);
	assert.equal(isMain(path.join(tmpdir(), "no-such-dir-workflow", "principles.mjs"), self), false);
	assert.equal(isMain(SCRIPT, self), true);
});

test("project dir: CLAUDE_PROJECT_DIR wins, else the hook input's cwd", () => {
	const on = project({ version: 1, principles: true });
	const off = project();
	assert.equal(principles({ cwd: off }, { CLAUDE_PROJECT_DIR: on }).stdout, rulesText());
	assert.equal(principles({ cwd: on }, {}).stdout, rulesText());
});

test("the rules: 8, numbered, under a header, well under the context cap", () => {
	const text = rulesText();
	const lines = text.split("\n");
	assert.equal(RULES.length, 8);
	assert.equal(lines.length, 9);
	lines.slice(1).forEach((l, i) => assert.ok(l.startsWith(`${i + 1}. `), l));
	assert.ok(text.length < 2000, `${text.length} chars`);
});

test("hooks.json: SessionStart on startup|resume|clear|compact runs the script that exists", () => {
	const cfg = JSON.parse(readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8"));
	const [entry] = cfg.hooks.SessionStart;
	assert.equal(entry.matcher, "startup|resume|clear|compact");
	const [hook] = entry.hooks;
	assert.equal(hook.type, "command");
	const rel = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(hook.command)?.[1];
	assert.equal(rel, "scripts/principles.mjs");
	assert.ok(existsSync(path.join(PLUGIN, rel)));
});
