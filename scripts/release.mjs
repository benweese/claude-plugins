// Publishes GitHub releases for signed <plugin>--v<version> tags that the maintainer already pushed (made with
// `claude plugin tag --push`). It never creates, moves or pushes a tag. For each tag, in this order:
//   1. skip it if that version already has a release (under <plugin>--v<version> or the old <plugin>-v<version>)
//   2. the tagged commit must be on main (an ancestor of origin/main)
//   3. the tag must be annotated, with a signature GitHub reports as verified
//   4. at the tagged commit, plugin.json and the marketplace.json entry must both say the tag's version
//   5. at the tagged commit, the plugin's CHANGELOG.md must have a "## [<version>]" section (the release notes)
// A failed check is an error for that tag (no release); the others still run, and the exit code is 1.
//
//   node scripts/release.mjs [--dry-run] [--tag <plugin>--v<version>]
//   CI: .github/workflows/release.yml on a pushed *--v* tag (that tag), or by hand (one tag, or every --v tag
//   without a release). RELEASE_TAG in the environment works like --tag. Needs gh with a token that can read the
//   repo and create releases.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The body of `## [version]` in a Keep a Changelog file (up to the next `## `), or null. */
export function changelogSection(text, version) {
	const lines = String(text).split("\n");
	const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const start = lines.findIndex((l) => new RegExp(`^## \\[${esc}\\](?:\\s|$)`).test(l));
	if (start === -1) return null;
	let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
	if (end === -1) end = lines.length;
	const body = lines.slice(start + 1, end).join("\n").trim();
	return body || null;
}

/** <plugin>--v<version> (semver, optional pre-release) → {plugin, version}, or null. */
export function parseTag(tag) {
	const m = /^([a-z0-9][a-z0-9-]*?)--v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag));
	return m ? { plugin: m[1], version: m[2] } : null;
}

/** Runs a command; {status, stdout, stderr}. */
const exec = (cmd, args, cwd) => {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
	return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || (r.error ? r.error.message : "") };
};

/** The real git and gh, run in `root`. Tests pass their own runner with the same shape. */
export const realRunner = (root) => ({ git: (args) => exec("git", args, root), gh: (args) => exec("gh", args, root) });

/** stdout of a call that must succeed. */
function ok(r, what) {
	if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim()}`);
	return r.stdout;
}

/** Tag names that already have a GitHub release. */
export function publishedTags(runner, repo) {
	const out = ok(runner.gh(["api", "--paginate", `repos/${repo}/releases`, "--jq", ".[].tag_name"]), "listing releases");
	return new Set(out.split("\n").filter(Boolean));
}

/** Every <plugin>--v<version> tag on origin. */
export function remoteReleaseTags(runner) {
	const out = ok(runner.git(["ls-remote", "--tags", "origin"]), "listing tags");
	return out.split("\n").map((l) => l.split("\t")[1] || "").filter((r) => r.startsWith("refs/tags/") && !r.endsWith("^{}")).map((r) => r.slice("refs/tags/".length)).filter((t) => parseTag(t));
}

/** What GitHub says about a tag: {kind: "lightweight" | "annotated" | "nested", commit, verified, reason}. */
function tagFacts(runner, repo, tag) {
	const ref = JSON.parse(ok(runner.gh(["api", `repos/${repo}/git/ref/tags/${tag}`]), `reading the tag ${tag}`));
	if (ref.object.type === "commit") return { kind: "lightweight", commit: ref.object.sha };
	const obj = JSON.parse(ok(runner.gh(["api", `repos/${repo}/git/tags/${ref.object.sha}`]), `reading the tag object of ${tag}`));
	if (obj.object.type !== "commit") return { kind: "nested", commit: null };
	return { kind: "annotated", commit: obj.object.sha, verified: obj.verification?.verified === true, reason: obj.verification?.reason || "unknown" };
}

/**
 * Checks one tag, in the order above: {action: "release", tag, name, version, notes, prerelease} |
 * {action: "skip", tag, reason} | {action: "error", tag, reason}.
 * @param {string} tag
 * @param {{runner: object, repo: string, published: Set<string>, mainRef?: string}} ctx
 */
export function checkTag(tag, { runner, repo, published, mainRef = "origin/main" }) {
	const parsed = parseTag(tag);
	if (!parsed) return { action: "error", tag, reason: "not a <plugin>--v<version> tag" };
	const { plugin, version } = parsed;
	const old = `${plugin}-v${version}`;
	if (published.has(tag) || published.has(old)) return { action: "skip", tag, reason: `already released (${published.has(tag) ? tag : old})` };
	let facts;
	try {
		facts = tagFacts(runner, repo, tag);
	} catch (e) {
		return { action: "error", tag, reason: e.message };
	}
	if (facts.kind === "nested") return { action: "error", tag, reason: "the tag points to another tag, not a commit" };
	if (runner.git(["cat-file", "-e", `${facts.commit}^{commit}`]).status !== 0) return { action: "error", tag, reason: `tagged commit ${facts.commit.slice(0, 7)} isn't in this checkout (fetch-depth: 0?)` };
	const onMain = runner.git(["merge-base", "--is-ancestor", facts.commit, mainRef]);
	if (onMain.status === 1) return { action: "error", tag, reason: "tagged commit is not on main" };
	if (onMain.status !== 0) return { action: "error", tag, reason: `couldn't check the tagged commit against ${mainRef}: ${onMain.stderr.trim()}` };
	if (facts.kind === "lightweight") return { action: "error", tag, reason: "lightweight tag, not released (make it with `claude plugin tag --push`)" };
	if (!facts.verified) {
		return { action: "error", tag, reason: facts.reason === "unsigned" ? "annotated but unsigned" : `signature not verified by GitHub (${facts.reason})` };
	}
	const show = (p) => runner.git(["show", `${facts.commit}:${p}`]);
	let market;
	try {
		market = JSON.parse(ok(show(".claude-plugin/marketplace.json"), "reading marketplace.json at the tagged commit"));
	} catch (e) {
		return { action: "error", tag, reason: e.message };
	}
	const entry = (market.plugins || []).find((p) => p.name === plugin);
	if (!entry) return { action: "error", tag, reason: `no plugin "${plugin}" in marketplace.json at the tagged commit` };
	const source = String(entry.source || "").replace(/^\.\//, "");
	const manifest = show(`${source}/.claude-plugin/plugin.json`);
	if (manifest.status !== 0) return { action: "error", tag, reason: `no ${source}/.claude-plugin/plugin.json at the tagged commit` };
	const pj = JSON.parse(manifest.stdout).version;
	if (pj !== version) return { action: "error", tag, reason: `plugin.json says ${pj}, the tag says ${version}` };
	if (entry.version !== undefined && entry.version !== version) return { action: "error", tag, reason: `marketplace.json says ${entry.version}, the tag says ${version}` };
	const log = show(`${source}/CHANGELOG.md`);
	const notes = log.status === 0 ? changelogSection(log.stdout, version) : null;
	if (!notes) return { action: "error", tag, reason: `no "## [${version}]" section in ${source}/CHANGELOG.md at the tagged commit` };
	return { action: "release", tag, name: plugin, version, notes, prerelease: version.includes("-") };
}

/** Checks each tag: {release: [...], skip: [...], errors: [...]}. */
export function planReleases(tags, ctx) {
	const out = { release: [], skip: [], errors: [] };
	for (const tag of tags) {
		const r = checkTag(tag, ctx);
		(r.action === "release" ? out.release : r.action === "skip" ? out.skip : out.errors).push(r);
	}
	return out;
}

/** Publishes one release for an existing tag (`--verify-tag`: gh refuses if the tag is missing; it never creates one). */
export function publish(runner, r) {
	const notes = path.join(mkdtempSync(path.join(tmpdir(), "release-")), "notes.md");
	writeFileSync(notes, `${r.notes}\n`);
	const args = ["release", "create", r.tag, "--verify-tag", "--title", `${r.name} ${r.version}`, "--notes-file", notes];
	if (r.prerelease) args.push("--prerelease");
	ok(runner.gh(args), `creating the release for ${r.tag}`);
}

/** The whole script: returns the exit code. */
export function main(argv, env = process.env, runner = realRunner(process.cwd()), log = console.log, logError = console.error) {
	const dry = argv.includes("--dry-run");
	const i = argv.indexOf("--tag");
	const one = (i !== -1 ? argv[i + 1] : env.RELEASE_TAG) || "";
	try {
		runner.git(["fetch", "--quiet", "origin"]); // best effort: an up-to-date origin/main and tags
		const repo = env.GITHUB_REPOSITORY || ok(runner.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]), "finding the repo").trim();
		const tags = one ? [one] : remoteReleaseTags(runner);
		const plan = planReleases(tags, { runner, repo, published: publishedTags(runner, repo) });
		for (const s of plan.skip) log(`skip ${s.tag}: ${s.reason}`);
		for (const r of plan.release) {
			if (dry) log(`would release ${r.tag}${r.prerelease ? " (pre-release)" : ""}:\n${r.notes}\n`);
			else {
				publish(runner, r);
				log(`released ${r.tag}`);
			}
		}
		for (const e of plan.errors) logError(`not released ${e.tag}: ${e.reason}`);
		if (!plan.release.length && !plan.errors.length) log("Nothing to release.");
		return plan.errors.length ? 1 : 0;
	} catch (e) {
		logError(e.message);
		return 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2));
}
