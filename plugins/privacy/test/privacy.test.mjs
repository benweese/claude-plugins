// node:test for the privacy plugin. Every "personal" value here is made up, and the ones that would trip
// scanners of this repo (emails, card-like numbers) are assembled at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { builtInDetectors, loadDenylist, loadPrivacyConfig, luhn, parseDenylist, scanChunks } from "../scripts/detectors.mjs";
import { privacyPreBash } from "../scripts/pre-bash.mjs";
import { refresh, scan } from "../scripts/scan.mjs";
import { install } from "../bin/install-privacy-git-hook";

const EMAIL = ["pat.quill", "@", "brightmail", ".co"].join("");
const CARD = ["4111", "1111", "1111", "1111"].join(" "); // the standard test Visa number (passes Luhn)
const CARD_DIGITS = CARD.replace(/ /g, "");
const SSN = ["212", "55", "1234"].join("-"); // made up
const PHONE = ["(402)", "867-5309"].join(" "); // made up
const unix = process.platform !== "win32";

function repo(config) {
	const dir = mkdtempSync(path.join(tmpdir(), "privacy-"));
	const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
	g("init", "-q", "-b", "main");
	g("config", "user.email", "t@example.invalid");
	g("config", "user.name", "T");
	writeFileSync(path.join(dir, "readme.md"), "hello\n");
	g("add", ".");
	g("commit", "-qm", "init");
	if (config !== undefined) {
		mkdirSync(path.join(dir, ".claude"), { recursive: true });
		writeFileSync(path.join(dir, ".claude", "privacy.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	return { dir, g, write: (f, s) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), s); } };
}
const chunk = (...lines) => [{ file: "x.txt", lines: lines.map((text, i) => ({ n: i + 1, text })) }];
const names = (findings) => findings.map((f) => f.detector);
const base = { dollarAmounts: false, patterns: [], allowlist: [] };

test("config: missing / invalid / wrong version → hook off; invalid warns", () => {
	assert.equal(loadPrivacyConfig(repo().dir).commitHook, false);
	const bad = loadPrivacyConfig(repo("{nope").dir);
	assert.equal(bad.commitHook, false);
	assert.match(bad.warning, /invalid/);
	assert.equal(loadPrivacyConfig(repo({ version: 2, commitHook: true }).dir).commitHook, false);
	assert.equal(loadPrivacyConfig(repo({ version: 1, commitHook: true }).dir).commitHook, true);
});

test("detectors: emails (safe domains skipped), Luhn cards, SSN-like, US phones", () => {
	const d = (line) => names(scanChunks(chunk(line), base));
	assert.deepEqual(d(`contact ${EMAIL}`), ["email address"]);
	for (const safe of ["a@example.com", "b@test.example.org", "x@app.invalid", "noreply@acme.co", "1+me@users.noreply.github.com"]) assert.deepEqual(d(safe), [], safe);
	assert.equal(luhn(CARD_DIGITS), true);
	assert.equal(luhn(`${CARD_DIGITS.slice(0, -1)}2`), false);
	assert.deepEqual(d(`card ${CARD}`), ["card number"]);
	assert.deepEqual(d(`order ${CARD_DIGITS.slice(0, -1)}2`), [], "fails Luhn");
	assert.deepEqual(d("id 0000000000000000"), [], "all one digit");
	assert.deepEqual(d(`ssn ${SSN}`), ["SSN-like number"]);
	assert.deepEqual(d("ssn 666-12-3456 or 912-12-3456"), [], "never-issued prefixes");
	assert.deepEqual(d(`call ${PHONE}`), ["US phone number"]);
	assert.deepEqual(d("call 402-555-0123"), [], "555-01xx is reserved for fiction");
	assert.deepEqual(d("version 1.2.3-4567"), []);
});

test("dollar amounts are off unless privacy.json turns them on", () => {
	assert.deepEqual(names(scanChunks(chunk("costs $1,234.56"), base)), []);
	assert.deepEqual(names(scanChunks(chunk("costs $1,234.56"), { ...base, dollarAmounts: true })), ["dollar amount"]);
	assert.equal(builtInDetectors({ dollarAmounts: true }).length, 5);
});

test("denylist: whole words for names, digit boundaries for numbers, case-insensitive", () => {
	const deny = parseDenylist("# people\nKy\nRiverbend Lane  # street\n4321\n");
	const d = (line) => names(scanChunks(chunk(line), base, deny));
	assert.deepEqual(d("Ky went out"), ["denylist entry 1"]);
	assert.deepEqual(d("the sky is blue; skyline; Kyle"), [], "Ky doesn't hit sky / Kyle");
	assert.deepEqual(d("lives on riverbend   lane"), ["denylist entry 2"]);
	assert.deepEqual(d("card ending 4321."), ["denylist entry 3"]);
	assert.deepEqual(d("line 43210 and 14321"), [], "no digit before/after");
	assert.deepEqual(d("v4321b"), ["denylist entry 3"], "letters around a number are fine boundaries");
});

test("allowlist (literal or /regex/) and custom patterns", () => {
	const r = repo({ version: 1, commitHook: true, allowlist: [EMAIL, "/^\\(402\\)/"], patterns: [{ name: "employee id", regex: "EMP-\\d{5}" }] });
	const cfg = loadPrivacyConfig(r.dir);
	assert.deepEqual(names(scanChunks(chunk(`${EMAIL} ${PHONE}`), cfg)), []);
	assert.deepEqual(names(scanChunks(chunk("badge EMP-12345"), cfg)), ["employee id"]);
});

test("denylist file: missing → visible note; not gitignored → warning; URL cache stale → note", () => {
	const r = repo({ version: 1, commitHook: true, denylist: "private/deny.txt" });
	let cfg = loadPrivacyConfig(r.dir);
	assert.match(loadDenylist(r.dir, cfg).notes[0], /denylist skipped — private\/deny\.txt not found/);
	r.write("private/deny.txt", "Ky\n");
	assert.match(loadDenylist(r.dir, cfg).notes.join(), /isn't gitignored/);
	r.write(".gitignore", "private/\n");
	assert.deepEqual(loadDenylist(r.dir, cfg).notes, []);
	const u = repo({ version: 1, commitHook: true, denylist: "https://example.invalid/deny.txt" });
	cfg = loadPrivacyConfig(u.dir);
	assert.match(loadDenylist(u.dir, cfg).notes[0], /no cached copy yet/);
	u.write(".claude/privacy/denylist.cache", "Ky\n");
	u.write(".gitignore", ".claude/privacy/\n");
	assert.deepEqual(loadDenylist(u.dir, cfg).notes, []);
	assert.match(loadDenylist(u.dir, cfg, Date.now() + 8 * 86_400_000).notes[0], /days old/);
});

test("refresh: a URL is downloaded into the cache (the hook never fetches); gh: uses the gh CLI", { skip: !unix }, async () => {
	const server = createServer((_, res) => res.end("# list\nKy\nRiverbend Lane\n"));
	await new Promise((ok) => server.listen(0, ok));
	try {
		const r = repo({ version: 1, commitHook: true, denylist: `http://127.0.0.1:${server.address().port}/deny.txt` });
		const msg = await refresh(r.dir, loadPrivacyConfig(r.dir));
		assert.match(msg, /Saved 2 denylist entries .* isn't gitignored/);
		assert.equal(readFileSync(path.join(r.dir, ".claude/privacy/denylist.cache"), "utf8").includes("Ky"), true);
	} finally {
		server.close();
	}
	const bin = mkdtempSync(path.join(tmpdir(), "fake-gh-"));
	writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho Ky\n");
	chmodSync(path.join(bin, "gh"), 0o755);
	const old = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${old}`;
	try {
		const g = repo({ version: 1, commitHook: true, denylist: "gh:someone/private-repo/deny.txt" });
		assert.match(await refresh(g.dir, loadPrivacyConfig(g.dir)), /Saved 1 denylist entries/);
	} finally {
		process.env.PATH = old;
	}
});

test("commit hook: off by default; opted in, blocks staged / git add . / -am; clean passes", () => {
	const off = repo();
	off.write("a.txt", `${EMAIL}\n`);
	off.g("add", "a.txt");
	assert.equal(privacyPreBash({ cwd: off.dir, tool_input: { command: "git commit -m x" } }, { CLAUDE_PROJECT_DIR: off.dir }).json, undefined);
	const on = repo({ version: 1, commitHook: true });
	const run = (cmd) => privacyPreBash({ cwd: on.dir, tool_input: { command: cmd } }, { CLAUDE_PROJECT_DIR: on.dir }).json?.hookSpecificOutput;
	on.write("a.txt", `${EMAIL}\n`);
	on.g("add", "a.txt");
	const denied = run("git commit -m x");
	assert.equal(denied.permissionDecision, "deny");
	assert.match(denied.permissionDecisionReason, /a\.txt:1\s+email address/);
	assert.doesNotMatch(denied.permissionDecisionReason, new RegExp(EMAIL.replace(/[.]/g, "\\.")));
	on.g("reset", "-q", "a.txt");
	assert.equal(run("git commit -m x"), undefined, "not staged → not committed");
	assert.equal(run("git add . && git commit -m x").permissionDecision, "deny");
	on.g("add", "a.txt");
	on.g("commit", "-qm", "with it", "--no-verify");
	on.write("readme.md", `hello\n${CARD}\n`);
	assert.equal(run("git commit -am x").permissionDecision, "deny");
	assert.equal(run("git status"), undefined);
});

test("/privacy-scan: staged, paths, whole repo; exit codes", () => {
	const r = repo({ version: 1 });
	r.write("docs/a.md", `mail ${EMAIL}\n`);
	assert.equal(scan(r.dir, ["docs"]).code, 1);
	assert.match(scan(r.dir, ["docs"]).text, /docs\/a\.md:1\s+email address/);
	assert.equal(scan(r.dir, []).code, 0, "untracked files aren't in the whole-repo scan");
	r.g("add", "docs/a.md");
	assert.equal(scan(r.dir, ["staged"]).code, 1);
	assert.doesNotMatch(scan(r.dir, ["staged"]).text, /brightmail/);
});

test("git hook installer: installs where git looks, refuses to overwrite, respects core.hooksPath, stops for husky", { skip: !unix }, () => {
	const r = repo({ version: 1, commitHook: true });
	const ok = install(r.dir);
	assert.equal(ok.ok, true, ok.message);
	assert.match(ok.message, /Installed: git will run \.git\/hooks\/pre-commit/);
	assert.equal(install(r.dir).ok, false, "a hook exists now");
	assert.match(install(r.dir).message, /already exists .* nothing was changed/s);
	assert.equal(install(r.dir, { force: true }).ok, true);
	// the installed hook really blocks a plain git commit, and holds no denylist values
	r.write(".claude/deny.txt", "Riverbend Lane\n");
	r.write(".gitignore", ".claude/deny.txt\n");
	writeFileSync(path.join(r.dir, ".claude", "privacy.json"), JSON.stringify({ version: 1, commitHook: true, denylist: ".claude/deny.txt" }));
	r.write("note.txt", "meet at Riverbend Lane\n");
	r.g("add", "note.txt", ".gitignore");
	const blocked = r.g("commit", "-m", "x");
	assert.notEqual(blocked.status, 0);
	assert.match(blocked.stderr, /note\.txt:1\s+denylist entry 1/);
	assert.doesNotMatch(readFileSync(path.join(r.dir, ".git/hooks/pre-commit"), "utf8") + readFileSync(path.join(r.dir, ".git/hooks/privacy/git-pre-commit.mjs"), "utf8"), /Riverbend/);
	// core.hooksPath (a custom folder) → installs there
	const c = repo({ version: 1, commitHook: true });
	c.g("config", "core.hooksPath", "githooks");
	const res = install(c.dir);
	assert.equal(res.ok, true, res.message);
	assert.equal(existsSync(path.join(c.dir, "githooks", "pre-commit")), true);
	// husky → stops and explains
	const h = repo();
	h.g("config", "core.hooksPath", ".husky/_");
	const hr = install(h.dir);
	assert.equal(hr.ok, false);
	assert.match(hr.message, /uses husky .* nothing was installed/s);
	// not a repo → stops
	assert.equal(install(mkdtempSync(path.join(tmpdir(), "norepo-"))).ok, false);
	// warns when the project hasn't opted in
	const n = repo();
	assert.match(install(n.dir).message, /won't block anything until/);
});
