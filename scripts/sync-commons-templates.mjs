// Regenerates the qa plugin's helper templates from one tag of playwright-test-commons.
//   node scripts/sync-commons-templates.mjs [tag]     (default: the tag in the current manifest)
// Clones the tag, copies src/ (minus the check-test-ids CLI, which stays in commons) into
// plugins/qa/templates/commons/ts/, builds it and copies the compiled .js + .d.ts into .../js/, and writes
// manifest.json (tag, bundles, devDependencies from commons' package.json, sha256 per file).
// Nothing is edited except the bundle entry files, which are split out of commons' src/index.ts.
// CI runs this for the pinned tag and fails on any diff; test/commons-templates.test.mjs fails if a template
// no longer matches its recorded hash.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "plugins", "qa", "templates", "commons");
const REPO = "https://github.com/benweese/playwright-test-commons.git";
const SKIP = /^(bin|tools)\//; // check-test-ids stays in commons
const UI = /^ui(\/|\.)/; // ui/… and the ui.* entry

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const bundleOf = (rel) => (UI.test(rel) ? "ui" : "core");

function walk(dir, base = dir, out = []) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, e.name);
		if (e.isDirectory()) walk(abs, base, out);
		else out.push(path.relative(base, abs).split(path.sep).join("/"));
	}
	return out.sort();
}

/** Splits commons' index (src or compiled) into the core entry and the ui entry. */
function splitIndex(text, ext) {
	const lines = text.split("\n").filter((l) => !/sourceMappingURL/.test(l));
	const exportsOnly = [];
	let buf = "";
	for (const l of lines) {
		if (!buf && !/^export\b/.test(l)) continue;
		buf += `${l}\n`;
		if (/;\s*$/.test(l)) {
			exportsOnly.push(buf);
			buf = "";
		}
	}
	const head = (what) => `// Entry for the ${what} bundle, split from @benweese/playwright-test-commons' index${ext}.\n`;
	return {
		core: head("core + api") + exportsOnly.filter((s) => !/\.\/ui\//.test(s)).join(""),
		ui: head("ui") + exportsOnly.filter((s) => /\.\/ui\//.test(s)).join("")
	};
}

export function sync(tag) {
	const tmp = mkdtempSync(path.join(tmpdir(), "commons-"));
	try {
		execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", tag, REPO, tmp], { stdio: "inherit" });
		const pkg = JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8"));
		const files = {};
		// TypeScript sources.
		for (const rel of walk(path.join(tmp, "src"))) {
			if (SKIP.test(rel) || rel === "index.ts") continue;
			files[`ts/${rel}`] = readFileSync(path.join(tmp, "src", rel), "utf8");
		}
		const srcIndex = splitIndex(readFileSync(path.join(tmp, "src", "index.ts"), "utf8"), ".ts");
		files["ts/index.ts"] = srcIndex.core;
		files["ts/ui.ts"] = srcIndex.ui;
		// Compiled JS + declarations (commons doesn't commit dist/, so build it at the tag).
		execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tmp, stdio: "inherit" });
		execFileSync("npm", ["run", "build"], { cwd: tmp, stdio: "inherit" });
		for (const rel of walk(path.join(tmp, "dist"))) {
			if (SKIP.test(rel) || /\.map$/.test(rel) || /^index\.(js|d\.ts)$/.test(rel)) continue;
			const text = readFileSync(path.join(tmp, "dist", rel), "utf8").replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n");
			files[`js/${rel}`] = text;
		}
		for (const ext of [".js", ".d.ts"]) {
			const idx = splitIndex(readFileSync(path.join(tmp, "dist", `index${ext}`), "utf8"), ext);
			files[`js/index${ext}`] = idx.core;
			files[`js/ui${ext}`] = idx.ui;
		}
		rmSync(OUT, { recursive: true, force: true });
		const hashes = {};
		for (const [rel, text] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
			writeFileSync(path.join(OUT, rel), text);
			hashes[rel] = sha256(text);
		}
		const dep = (name) => pkg.dependencies?.[name] ?? pkg.peerDependencies?.[name];
		const manifest = {
			source: "@benweese/playwright-test-commons",
			tag,
			version: pkg.version,
			bundles: {
				core: { entry: "index", devDependencies: Object.fromEntries(["@playwright/test", "ajv", "ajv-formats", "dayjs", "genson-js"].map((n) => [n, dep(n)])) },
				ui: { entry: "ui", devDependencies: Object.fromEntries(["@playwright/test", "@axe-core/playwright"].map((n) => [n, dep(n)])) }
			},
			typescriptDevDependencies: { "@types/node": pkg.devDependencies?.["@types/node"] },
			files: Object.fromEntries(Object.keys(files).sort().map((rel) => [rel, { bundle: bundleOf(rel.replace(/^(ts|js)\//, "")), sha256: hashes[rel] }]))
		};
		writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		return manifest;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const current = existsSync(path.join(OUT, "manifest.json")) ? JSON.parse(readFileSync(path.join(OUT, "manifest.json"), "utf8")).tag : null;
	const tag = process.argv[2] || current;
	if (!tag) {
		console.error("Give a tag, e.g. node scripts/sync-commons-templates.mjs v0.8.0");
		process.exit(1);
	}
	const m = sync(tag);
	console.log(`Templates from ${m.source} ${m.tag}: ${Object.keys(m.files).length} files (core + ui, ts + js).`);
}
