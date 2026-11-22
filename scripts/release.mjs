// Releases plugins whose version has no tag yet: tags <plugin>-v<version> and publishes a GitHub release whose
// notes are that version's section of the plugin's CHANGELOG.md. Versions stay hand-bumped in plugin.json (CI keeps
// plugin.json, marketplace.json and the README in step); this only publishes what's on main.
//
//   node scripts/release.mjs [--dry-run]      (CI: .github/workflows/release.yml, with gh and GITHUB_TOKEN)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** What to release: [{name, version, tag, notes}] for plugins whose tag isn't in `tags`. Throws on a missing CHANGELOG section. */
export function plan(root, tags) {
	const market = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
	const out = [];
	for (const p of market.plugins) {
		const dir = path.join(root, p.source);
		const { version } = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"));
		const tag = `${p.name}-v${version}`;
		if (tags.has(tag)) continue;
		const notes = changelogSection(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), version);
		if (!notes) throw new Error(`${p.name} ${version}: no "## [${version}]" section in ${path.join(p.source, "CHANGELOG.md")} — add one before releasing`);
		out.push({ name: p.name, version, tag, notes });
	}
	return out;
}

const run = (cmd, args) => {
	const r = spawnSync(cmd, args, { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
	return r.stdout;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dry = process.argv.includes("--dry-run");
	try {
		run("git", ["fetch", "--tags", "--quiet"]);
		const tags = new Set(run("git", ["tag", "--list"]).split("\n").filter(Boolean));
		const todo = plan(process.cwd(), tags);
		if (!todo.length) console.log("Nothing to release: every plugin's version is already tagged.");
		const target = process.env.GITHUB_SHA || run("git", ["rev-parse", "HEAD"]).trim();
		for (const r of todo) {
			if (dry) {
				console.log(`would release ${r.tag} at ${target.slice(0, 7)}:\n${r.notes}\n`);
				continue;
			}
			const notes = path.join(mkdtempSync(path.join(tmpdir(), "release-")), "notes.md");
			writeFileSync(notes, `${r.notes}\n`);
			run("gh", ["release", "create", r.tag, "--target", target, "--title", `${r.name} ${r.version}`, "--notes-file", notes]);
			console.log(`released ${r.tag}`);
		}
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
}
