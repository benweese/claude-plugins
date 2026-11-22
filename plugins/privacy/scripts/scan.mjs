#!/usr/bin/env node
// What /privacy-scan runs.
//   node scan.mjs                 every tracked file in the repo
//   node scan.mjs staged          what's staged for the next commit
//   node scan.mjs <path>…         those files / folders
//   node scan.mjs refresh         download a URL denylist (https://… or gh:owner/repo/path) into the cache
// Exit 0 = clean, 1 = findings, 2 = couldn't run. Values are never printed.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addedLines, git } from "./commit-content.mjs";
import { CACHE_FILE, formatFindings, isGitignored, loadDenylist, loadPrivacyConfig, scanChunks } from "./detectors.mjs";

const readChunk = (root, rel) => {
	try {
		const abs = path.join(root, rel);
		if (statSync(abs).size > 1_000_000) return null;
		const text = readFileSync(abs, "utf8");
		return text.includes("\u0000") ? null : { file: rel, lines: text.split("\n").map((t, i) => ({ n: i + 1, text: t })) };
	} catch {
		return null;
	}
};

function walk(root, rel, out) {
	const abs = path.join(root, rel);
	const st = statSync(abs, { throwIfNoEntry: false });
	if (!st) return;
	if (st.isDirectory()) {
		if (/(^|\/)(\.git|node_modules)$/.test(rel)) return;
		for (const e of readdirSync(abs)) walk(root, path.join(rel, e), out);
	} else out.push(rel);
}

/** Downloads the configured URL denylist into the cache. Returns a message; throws on failure. */
export async function refresh(projectDir, cfg) {
	if (!cfg.denylist || !/^(?:https?:\/\/|gh:)/.test(cfg.denylist)) return "Nothing to refresh: \"denylist\" in .claude/privacy.json isn't a URL (local files are read directly).";
	let text;
	const gh = /^gh:([^/]+)\/([^/]+)\/(.+)$/.exec(cfg.denylist);
	if (gh) {
		const r = spawnSync("gh", ["api", `repos/${gh[1]}/${gh[2]}/contents/${gh[3]}`, "-H", "Accept: application/vnd.github.raw"], { encoding: "utf8" });
		if (r.status !== 0) throw new Error(`gh couldn't read ${cfg.denylist}: ${(r.stderr || "").trim() || "is gh installed and logged in?"}`);
		text = r.stdout;
	} else {
		const res = await fetch(cfg.denylist);
		if (!res.ok) throw new Error(`downloading the denylist failed: HTTP ${res.status}`);
		text = await res.text();
	}
	const file = path.join(projectDir, CACHE_FILE);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
	const count = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
	const ignored = isGitignored(projectDir, CACHE_FILE);
	return `Saved ${count} denylist entries to ${CACHE_FILE}.${ignored === false ? ` Warning: ${CACHE_FILE} isn't gitignored — add it to .gitignore.` : ""}`;
}

/** Runs a scan; returns {code, text}. */
export function scan(projectDir, args, cfg = loadPrivacyConfig(projectDir)) {
	let chunks;
	let what;
	if (args[0] === "staged") {
		chunks = addedLines(git(projectDir, ["diff", "--cached", "-U0", "--no-color"]));
		what = "the staged changes";
	} else if (args.length) {
		const files = [];
		for (const a of args) walk(projectDir, path.relative(projectDir, path.resolve(projectDir, a)), files);
		chunks = files.map((f) => readChunk(projectDir, f)).filter(Boolean);
		what = args.join(", ");
	} else {
		const files = git(projectDir, ["ls-files"]).split("\n").filter(Boolean);
		if (!files.length) return { code: 2, text: "Not a git repo (or no tracked files) — give paths to scan instead." };
		chunks = files.map((f) => readChunk(projectDir, f)).filter(Boolean);
		what = `${files.length} tracked files`;
	}
	const { entries, notes } = loadDenylist(projectDir, cfg);
	const findings = scanChunks(chunks, cfg, entries);
	const head = [cfg.warning, ...notes].filter(Boolean).map((n) => `(${n})`).join("\n");
	const checked = `Checked ${what}: emails, card numbers (Luhn), SSN-like numbers, US phones${cfg.dollarAmounts ? ", dollar amounts" : ""}${cfg.patterns.length ? `, ${cfg.patterns.length} custom pattern(s)` : ""}${entries.length ? `, ${entries.length} denylist entries` : ""}.`;
	if (!findings.length) return { code: 0, text: `${checked}\nNo personal data found.${head ? `\n${head}` : ""}` };
	return { code: 1, text: `${checked}\n${findings.length} finding(s) (values hidden):\n${formatFindings(findings, 100)}${head ? `\n${head}` : ""}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const args = process.argv.slice(2);
	if (args[0] === "refresh") {
		try {
			console.log(await refresh(projectDir, loadPrivacyConfig(projectDir)));
		} catch (e) {
			console.log(`Refresh failed: ${e.message}`);
			process.exit(2);
		}
	} else {
		const r = scan(projectDir, args);
		console.log(r.text);
		process.exit(r.code);
	}
}
