// node:test for scripts/release.mjs: CHANGELOG sections, tag names, and the checks each pushed <plugin>--v<version>
// tag goes through before it gets a GitHub release (already released → skip; on main; annotated + verified;
// versions and CHANGELOG at the tagged commit). Real git repos; gh is a fake that answers the API calls and records
// every call, so the tests can prove nothing creates or pushes a tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { changelogSection, checkTag, main, parseTag, planReleases, remoteReleaseTags } from "../scripts/release.mjs";

const LOG = "# Changelog\n\nIntro.\n\n## [1.2.0] - 2026-11-21\n\n### Added\n\n- New thing.\n\n## [1.1.0] - 2026-11-20\n\n### Fixed\n\n- Old bug.\n";
const REPO = "example-owner/example-repo";

test("changelogSection: the version's body up to the next ## heading; exact version only", () => {
	assert.equal(changelogSection(LOG, "1.2.0"), "### Added\n\n- New thing.");
	assert.equal(changelogSection(LOG, "1.1.0"), "### Fixed\n\n- Old bug.");
	assert.equal(changelogSection(LOG, "1.2"), null, "1.2 isn't 1.2.0");
	assert.equal(changelogSection(LOG, "9.9.9"), null);
	assert.equal(changelogSection("## [1.0.0]\n\n## [0.9.0]\n- x\n", "1.0.0"), null, "an empty section is missing");
});

test("parseTag: <plugin>--v<semver>, nothing else", () => {
	assert.deepEqual(parseTag("qa--v1.5.1"), { plugin: "qa", version: "1.5.1" });
	assert.deepEqual(parseTag("my-plugin--v0.1.0-beta.2"), { plugin: "my-plugin", version: "0.1.0-beta.2" });
	for (const t of ["qa-v1.5.1", "qa--v1.5", "qa--1.5.1", "--v1.0.0", "QA--v1.0.0", "qa--v1.0.0/x", "a--v1.0.0--v2.0.0", "a--vx--v1.0.0"]) assert.equal(parseTag(t), null, t);
	const f = fixture();
	assert.deepEqual(checkTag("a--v1.0.0--v2.0.0", ctx(runner(f.dir))), { action: "error", tag: "a--v1.0.0--v2.0.0", reason: "not a <plugin>--v<version> tag" }, "rejected before any git or API call");
});

/**
 * A repo with one plugin "qa" (marketplace entry + plugin.json at `version`, CHANGELOG = LOG) committed on main,
 * and refs/remotes/origin/main pointing at main. Returns helpers to commit, branch and move origin/main.
 */
function fixture({ version = "1.2.0", marketVersion = version, log = LOG } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "release-"));
	const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" }).stdout.trim();
	g("init", "-q", "-b", "main");
	g("config", "user.email", "t@example.invalid");
	g("config", "user.name", "T");
	const write = (file, text) => {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), text);
	};
	const setVersions = (pv, mv = pv, changelog = log) => {
		write(".claude-plugin/marketplace.json", JSON.stringify({ plugins: [{ name: "qa", source: "./plugins/qa", version: mv }] }));
		write("plugins/qa/.claude-plugin/plugin.json", JSON.stringify({ name: "qa", version: pv }));
		write("plugins/qa/CHANGELOG.md", changelog);
	};
	const commit = (msg) => {
		g("add", ".");
		g("commit", "-qm", msg);
		return g("rev-parse", "HEAD");
	};
	setVersions(version, marketVersion);
	const first = commit("release");
	g("update-ref", "refs/remotes/origin/main", first);
	return { dir, g, write, setVersions, commit, first, moveMain: (sha) => g("update-ref", "refs/remotes/origin/main", sha) };
}

/**
 * A runner: real git in `dir` (except ls-remote / fetch, answered from `remoteTags`), and a fake gh. `tags` maps a
 * tag to {kind: "lightweight" | "annotated" | "nested", commit, verified, reason}; `released` lists release tags.
 */
function runner(dir, { tags = {}, released = [], remoteTags = Object.keys(tags) } = {}) {
	const calls = { git: [], gh: [] };
	const reply = (stdout, status = 0) => ({ status, stdout, stderr: status ? stdout : "" });
	return {
		calls,
		git(args) {
			calls.git.push(args);
			if (args[0] === "fetch") return reply("");
			if (args[0] === "ls-remote") return reply(remoteTags.map((t, i) => `${String(i).padStart(40, "0")}\trefs/tags/${t}`).join("\n"));
			const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
			return { status: r.status, stdout: r.stdout, stderr: r.stderr };
		},
		gh(args) {
			calls.gh.push(args);
			const api = args[0] === "api" ? args.filter((a) => !a.startsWith("-") && !a.startsWith("."))[1] : null;
			if (args[0] === "repo") return reply(REPO);
			if (args[0] === "release") return reply("");
			if (api === `repos/${REPO}/releases`) return reply(released.join("\n"));
			const ref = /^repos\/[^/]+\/[^/]+\/git\/ref\/tags\/(.+)$/.exec(api || "");
			if (ref) {
				const t = tags[ref[1]];
				if (!t) return reply("Not Found", 1);
				return reply(JSON.stringify({ object: t.kind === "lightweight" ? { type: "commit", sha: t.commit } : { type: "tag", sha: `tagobj-${ref[1]}` } }));
			}
			const obj = /^repos\/[^/]+\/[^/]+\/git\/tags\/tagobj-(.+)$/.exec(api || "");
			if (obj) {
				const t = tags[obj[1]];
				return reply(JSON.stringify({ object: t.kind === "nested" ? { type: "tag", sha: "x" } : { type: "commit", sha: t.commit }, verification: { verified: Boolean(t.verified), reason: t.reason || (t.verified ? "valid" : "unsigned") } }));
			}
			return reply(`unexpected gh call: ${args.join(" ")}`, 1);
		}
	};
}
const signed = (commit) => ({ kind: "annotated", commit, verified: true, reason: "valid" });
const ctx = (r, released = []) => ({ runner: r, repo: REPO, published: new Set(released) });

test("1. already released (under --v or the old -v name) → skip, before any other check", () => {
	const f = fixture();
	const side = (f.g("switch", "-qc", "side"), f.write("x.txt", "x\n"), f.commit("side"));
	const tags = { "qa--v1.2.0": { kind: "lightweight", commit: side } }; // off main AND lightweight
	for (const released of [["qa--v1.2.0"], ["qa-v1.2.0"]]) {
		const r = checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags }), released));
		assert.equal(r.action, "skip", released[0]);
		assert.match(r.reason, /already released/);
	}
});

test("2. a signed tag on a commit only on a side branch → not on main; after that commit is merged → released", () => {
	const f = fixture({ version: "1.1.0" });
	f.g("switch", "-qc", "side");
	f.setVersions("1.2.0");
	const side = f.commit("bump on a side branch");
	const tags = { "qa--v1.2.0": signed(side) };
	assert.deepEqual(checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags }))), { action: "error", tag: "qa--v1.2.0", reason: "tagged commit is not on main" });
	f.g("switch", "-q", "main");
	f.g("merge", "-q", "--no-ff", "-m", "merge", "side");
	f.moveMain(f.g("rev-parse", "HEAD"));
	const r = checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags })));
	assert.equal(r.action, "release", r.reason);
	assert.equal(r.notes, "### Added\n\n- New thing.");
});

test("2. on-main is checked before the tag kind: a lightweight tag off main reports 'not on main'", () => {
	const f = fixture();
	const side = (f.g("switch", "-qc", "side"), f.write("x.txt", "x\n"), f.commit("side"));
	assert.equal(checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags: { "qa--v1.2.0": { kind: "lightweight", commit: side } } }))).reason, "tagged commit is not on main");
});

test("3. annotated + verified only: lightweight, unsigned, unverified and nested tags aren't released", () => {
	const f = fixture();
	const cases = {
		lightweight: [{ kind: "lightweight", commit: f.first }, /^lightweight tag, not released/],
		unsigned: [{ kind: "annotated", commit: f.first, verified: false, reason: "unsigned" }, /^annotated but unsigned$/],
		unverified: [{ kind: "annotated", commit: f.first, verified: false, reason: "unknown_key" }, /^signature not verified by GitHub \(unknown_key\)$/],
		nested: [{ kind: "nested", commit: f.first }, /points to another tag/]
	};
	for (const [name, [spec, why]] of Object.entries(cases)) {
		const r = checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags: { "qa--v1.2.0": spec } })));
		assert.equal(r.action, "error", name);
		assert.match(r.reason, why, name);
	}
	assert.equal(checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags: { "qa--v1.2.0": signed(f.first) } }))).action, "release");
});

test("4. versions at the tagged commit: plugin.json and marketplace.json must match the tag", () => {
	const pj = fixture({ version: "1.1.0", marketVersion: "1.2.0" });
	assert.equal(checkTag("qa--v1.2.0", ctx(runner(pj.dir, { tags: { "qa--v1.2.0": signed(pj.first) } }))).reason, "plugin.json says 1.1.0, the tag says 1.2.0");
	const mj = fixture({ version: "1.2.0", marketVersion: "1.1.0" });
	assert.equal(checkTag("qa--v1.2.0", ctx(runner(mj.dir, { tags: { "qa--v1.2.0": signed(mj.first) } }))).reason, "marketplace.json says 1.1.0, the tag says 1.2.0");
	const unknown = fixture();
	assert.match(checkTag("docs--v1.2.0", ctx(runner(unknown.dir, { tags: { "docs--v1.2.0": signed(unknown.first) } }))).reason, /no plugin "docs" in marketplace\.json/);
});

test("4. versions are read at the tagged commit, not at HEAD", () => {
	const f = fixture();
	f.setVersions("1.3.0"); // HEAD moves on; the tag still points at the 1.2.0 commit
	f.moveMain(f.commit("next"));
	const r = checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags: { "qa--v1.2.0": signed(f.first) } })));
	assert.equal(r.action, "release", r.reason);
});

test("5. the CHANGELOG at the tagged commit needs a section for the version; its body is the notes", () => {
	const missing = fixture({ version: "1.3.0" });
	assert.equal(checkTag("qa--v1.3.0", ctx(runner(missing.dir, { tags: { "qa--v1.3.0": signed(missing.first) } }))).reason, 'no "## [1.3.0]" section in plugins/qa/CHANGELOG.md at the tagged commit');
	const f = fixture();
	f.setVersions("1.2.0", "1.2.0", LOG.replace("- New thing.", "- Edited after the tag."));
	f.moveMain(f.commit("edit changelog"));
	assert.equal(checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags: { "qa--v1.2.0": signed(f.first) } }))).notes, "### Added\n\n- New thing.", "the notes as tagged");
});

test("a pre-release version is published as a pre-release", () => {
	const f = fixture({ version: "1.2.0-beta.1", log: "## [1.2.0-beta.1] - 2026-11-25\n\n- Beta.\n" });
	const r = checkTag("qa--v1.2.0-beta.1", ctx(runner(f.dir, { tags: { "qa--v1.2.0-beta.1": signed(f.first) } })));
	assert.equal(r.prerelease, true);
});

test("planReleases sorts tags into release / skip / errors and keeps going past an error", () => {
	const f = fixture();
	const tags = { "qa--v1.1.0": { kind: "lightweight", commit: f.first }, "qa--v1.2.0": signed(f.first), "qa--v1.0.0": signed(f.first) };
	const p = planReleases(Object.keys(tags), ctx(runner(f.dir, { tags }), ["qa-v1.0.0"]));
	assert.deepEqual(p.release.map((r) => r.tag), ["qa--v1.2.0"]);
	assert.deepEqual(p.skip.map((r) => r.tag), ["qa--v1.0.0"]);
	assert.deepEqual(p.errors.map((r) => r.tag), ["qa--v1.1.0"]);
});

test("main: catch-up releases what passes, reports errors, exits 1; never creates or pushes a tag", () => {
	const f = fixture();
	const tags = { "qa--v1.2.0": signed(f.first), "qa--v1.1.0": { kind: "lightweight", commit: f.first }, "qa--v1.0.0": signed(f.first) };
	const r = runner(f.dir, { tags, released: ["qa-v1.0.0"] });
	const out = [];
	const err = [];
	const code = main([], { GITHUB_REPOSITORY: REPO }, r, (s) => out.push(s), (s) => err.push(s));
	assert.equal(code, 1);
	assert.deepEqual(out, ["skip qa--v1.0.0: already released (qa-v1.0.0)", "released qa--v1.2.0"]);
	assert.deepEqual(err, ["not released qa--v1.1.0: lightweight tag, not released (make it with `claude plugin tag --push`)"]);
	const creates = r.calls.gh.filter((a) => a[0] === "release");
	assert.equal(creates.length, 1);
	assert.deepEqual(creates[0].slice(0, 6), ["release", "create", "qa--v1.2.0", "--verify-tag", "--title", "qa 1.2.0"]);
	assert.equal(readFileSync(creates[0][creates[0].indexOf("--notes-file") + 1], "utf8"), "### Added\n\n- New thing.\n");
	// nothing that writes a tag or a ref
	for (const a of r.calls.git) assert.ok(["fetch", "ls-remote", "cat-file", "merge-base", "show"].includes(a[0]), `git ${a.join(" ")}`);
	for (const a of r.calls.gh) {
		if (a[0] === "release") assert.ok(a[1] === "create" && a.includes("--verify-tag"), a.join(" "));
		else if (a[0] === "api") assert.ok(!a.some((x) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(x)), `gh ${a.join(" ")} is read-only`);
		else assert.equal(a[0], "repo");
	}
});

test("main: --dry-run publishes nothing; --tag / RELEASE_TAG checks only that tag", () => {
	const f = fixture();
	const tags = { "qa--v1.2.0": signed(f.first), "qa--v1.1.0": { kind: "lightweight", commit: f.first } };
	const dry = runner(f.dir, { tags });
	const out = [];
	assert.equal(main(["--dry-run", "--tag", "qa--v1.2.0"], { GITHUB_REPOSITORY: REPO }, dry, (s) => out.push(s), () => {}), 0);
	assert.match(out[0], /^would release qa--v1\.2\.0:\n### Added/);
	assert.equal(dry.calls.gh.some((a) => a[0] === "release"), false);
	assert.equal(dry.calls.git.some((a) => a[0] === "ls-remote"), false, "one tag: no listing");
	const env = runner(f.dir, { tags });
	assert.equal(main([], { GITHUB_REPOSITORY: REPO, RELEASE_TAG: "qa--v1.2.0" }, env, () => {}, () => {}), 0);
	assert.equal(env.calls.gh.filter((a) => a[0] === "release").length, 1);
	const none = runner(f.dir, { tags: {}, remoteTags: [] });
	const msgs = [];
	assert.equal(main([], { GITHUB_REPOSITORY: REPO }, none, (s) => msgs.push(s), () => {}), 0);
	assert.deepEqual(msgs, ["Nothing to release."]);
});

test("every plugin in this repo has a CHANGELOG section for its current version", () => {
	const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
	const market = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
	for (const p of market.plugins) {
		const dir = path.join(root, p.source);
		const { version } = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"));
		assert.ok(changelogSection(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), version), `${p.name} ${version}`);
	}
});

test("malformed plugin.json at one tag → an error for that tag; another tag still releases", () => {
	const f = fixture();
	const good = f.first;
	f.write("plugins/qa/.claude-plugin/plugin.json", '{ "name": "qa", "version": '); // broken
	f.write("plugins/qa/CHANGELOG.md", `## [1.3.0] - 2026-11-25\n\n- x\n\n${LOG}`);
	f.write(".claude-plugin/marketplace.json", JSON.stringify({ plugins: [{ name: "qa", source: "./plugins/qa", version: "1.3.0" }] }));
	const bad = f.commit("broken plugin.json");
	f.moveMain(bad);
	const tags = { "qa--v1.2.0": signed(good), "qa--v1.3.0": signed(bad) };
	const p = planReleases(Object.keys(tags), ctx(runner(f.dir, { tags })));
	assert.deepEqual(p.release.map((r) => r.tag), ["qa--v1.2.0"]);
	assert.equal(p.errors.length, 1);
	assert.equal(p.errors[0].reason, `plugin.json at ${bad.slice(0, 7)} is not valid JSON (plugins/qa/.claude-plugin/plugin.json)`);
});

test("malformed marketplace.json at the tagged commit → error, no throw", () => {
	const f = fixture();
	f.write(".claude-plugin/marketplace.json", "{ nope");
	const bad = f.commit("broken marketplace");
	f.moveMain(bad);
	assert.equal(checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags: { "qa--v1.2.0": signed(bad) } }))).reason, `marketplace.json at ${bad.slice(0, 7)} is not valid JSON`);
});

test("a marketplace source that isn't a local ./ path → only local ./ sources are supported", () => {
	for (const source of [{ source: "github", repo: "example-owner/qa" }, "plugins/qa", 42]) {
		const f = fixture();
		f.write(".claude-plugin/marketplace.json", JSON.stringify({ plugins: [{ name: "qa", source, version: "1.2.0" }] }));
		const c = f.commit("other source");
		f.moveMain(c);
		const r = checkTag("qa--v1.2.0", ctx(runner(f.dir, { tags: { "qa--v1.2.0": signed(c) } })));
		assert.equal(r.action, "error", JSON.stringify(source));
		assert.match(r.reason, /^only local \.\/ sources are supported/, JSON.stringify(source));
	}
});

test("a malformed GitHub API response for a tag → error for that tag, the run continues", () => {
	const f = fixture();
	const r = runner(f.dir, { tags: { "qa--v1.2.0": signed(f.first), "qa--v1.1.0": signed(f.first) } });
	const gh = r.gh;
	r.gh = (args) => (String(args[1]).endsWith("/git/ref/tags/qa--v1.1.0") ? { status: 0, stdout: "<html>oops</html>", stderr: "" } : gh(args));
	const p = planReleases(["qa--v1.1.0", "qa--v1.2.0"], ctx(r));
	assert.deepEqual(p.release.map((x) => x.tag), ["qa--v1.2.0"]);
	assert.match(p.errors[0].reason, /GitHub's response for the tag qa--v1\.1\.0 isn't valid/);
});

test("main: a failed git fetch prints a warning and carries on", () => {
	const f = fixture();
	const r = runner(f.dir, { tags: {}, remoteTags: [] });
	const git = r.git;
	r.git = (args) => (args[0] === "fetch" ? { status: 128, stdout: "", stderr: "fatal: unable to access" } : git(args));
	const out = [];
	const err = [];
	assert.equal(main([], { GITHUB_REPOSITORY: REPO }, r, (s) => out.push(s), (s) => err.push(s)), 0);
	assert.deepEqual(err, ["warning: git fetch failed; origin/main may be stale"]);
	assert.deepEqual(out, ["Nothing to release."]);
});

test("release.yml: per-ref concurrency group, no cancelling; tag-push and manual triggers only", () => {
	const yml = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "release.yml"), "utf8");
	assert.match(yml, /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false$/m);
	assert.match(yml, /^ {2}push:\n {4}tags: \["\*--v\*"\]$/m);
	assert.match(yml, /^ {2}workflow_dispatch:$/m);
	assert.doesNotMatch(yml, /branches:/, "no longer runs on pushes to main");
	assert.match(yml, /^ {10}ref: main$/m, "checkout runs main's release.mjs");
	assert.match(yml, /^ {10}fetch-depth: 0\b/m);
	assert.match(yml, /RELEASE_TAG: \$\{\{ github\.event_name == 'push' && github\.ref_name \|\| inputs\.tag \}\}/, "the tag still comes from the pushed ref");
});

test("a release created by someone else meanwhile is a skip, not an error (re-check before create, and 'already exists')", () => {
	const f = fixture();
	const tags = { "qa--v1.2.0": signed(f.first) };
	// 1. the re-check right before create sees it: no create call at all
	const r1 = runner(f.dir, { tags });
	let lists = 0;
	const gh1 = r1.gh;
	r1.gh = (args) => (String(args[2]).endsWith("/releases") && ++lists > 1 ? { status: 0, stdout: "qa--v1.2.0\n", stderr: "" } : gh1(args));
	const out1 = [];
	assert.equal(main([], { GITHUB_REPOSITORY: REPO }, r1, (s) => out1.push(s), () => {}), 0);
	assert.deepEqual(out1, ["skip qa--v1.2.0: already released (qa--v1.2.0)"]);
	assert.equal(r1.calls.gh.some((a) => a[0] === "release"), false);
	// 2. it appears between the re-check and the create: gh says "already exists"
	const r2 = runner(f.dir, { tags });
	const gh2 = r2.gh;
	r2.gh = (args) => (args[0] === "release" ? (r2.calls.gh.push(args), { status: 1, stdout: "", stderr: "HTTP 422: Validation Failed\na release with the same tag name already exists: qa--v1.2.0" }) : gh2(args));
	const out2 = [];
	const err2 = [];
	assert.equal(main([], { GITHUB_REPOSITORY: REPO }, r2, (s) => out2.push(s), (s) => err2.push(s)), 0);
	assert.deepEqual(out2, ["skip qa--v1.2.0: already released (created while this run was going)"]);
	assert.deepEqual(err2, []);
	// any other create failure is an error for that tag (exit 1), not an abort
	const r3 = runner(f.dir, { tags });
	const gh3 = r3.gh;
	r3.gh = (args) => (args[0] === "release" ? { status: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" } : gh3(args));
	const err3 = [];
	assert.equal(main([], { GITHUB_REPOSITORY: REPO }, r3, () => {}, (s) => err3.push(s)), 1);
	assert.match(err3[0], /^not released qa--v1\.2\.0: creating the release for qa--v1\.2\.0: HTTP 403/);
});

test("--tag and RELEASE_TAG are trimmed", () => {
	const f = fixture();
	const tags = { "qa--v1.2.0": signed(f.first) };
	for (const [argv, env] of [[["--dry-run", "--tag", "  qa--v1.2.0 \n"], {}], [["--dry-run"], { RELEASE_TAG: " qa--v1.2.0\t" }]]) {
		const r = runner(f.dir, { tags });
		const out = [];
		const err = [];
		assert.equal(main(argv, { GITHUB_REPOSITORY: REPO, ...env }, r, (s) => out.push(s), (s) => err.push(s)), 0, err.join("\n"));
		assert.match(out[0], /^would release qa--v1\.2\.0:/);
	}
	const blank = runner(f.dir, { tags: {}, remoteTags: [] });
	const out = [];
	assert.equal(main([], { GITHUB_REPOSITORY: REPO, RELEASE_TAG: "   " }, blank, (s) => out.push(s), () => {}), 0);
	assert.equal(blank.calls.git.some((a) => a[0] === "ls-remote"), true, "a blank RELEASE_TAG means catch-up");
});

test("remoteReleaseTags: only <plugin>--v<version> names, each once (peeled ^{} lines, other tags ignored)", () => {
	const lsRemote = [
		"1111111111111111111111111111111111111111\trefs/tags/qa--v1.5.1",
		"2222222222222222222222222222222222222222\trefs/tags/qa--v1.5.1^{}",
		"3333333333333333333333333333333333333333\trefs/tags/v0.10.0",
		"4444444444444444444444444444444444444444\trefs/tags/v0.10.0^{}",
		"5555555555555555555555555555555555555555\trefs/tags/qa-v1.5.1",
		"6666666666666666666666666666666666666666\trefs/tags/docs--v0.2.0",
		"7777777777777777777777777777777777777777\trefs/heads/main",
		""
	].join("\n");
	const fake = { git: (args) => (args[0] === "ls-remote" ? { status: 0, stdout: lsRemote, stderr: "" } : { status: 1, stdout: "", stderr: "unexpected" }) };
	assert.deepEqual(remoteReleaseTags(fake), ["qa--v1.5.1", "docs--v0.2.0"]);
});
