#!/usr/bin/env node
// What /a11y runs: a one-off axe scan of a page while you build it. Writes no test files.
//   node scan.mjs <url | path/to/file.html> [--json]
// Uses the PROJECT's own playwright (via @playwright/test or playwright) and @axe-core/playwright — nothing is
// downloaded. If they aren't installed, it says the scan was skipped and how to install them (exit 3).
// WCAG version and level come from .claude/a11y.json (default 2.2 AA). Exit 0 = no automated violations,
// 1 = violations, 2 = couldn't run, 3 = skipped (tools missing).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { axeTags, formatViolations, loadA11yConfig } from "./lib.mjs";

/** Imports a package the way the project would (resolved from its package.json), or null. */
async function projectImport(projectDir, names) {
	const req = createRequire(path.join(projectDir, "package.json"));
	for (const name of names) {
		try {
			return { name, mod: await import(pathToFileURL(req.resolve(name)).href) };
		} catch {
			/* try the next one */
		}
	}
	return null;
}

/** Runs the scan; returns {code, text, results?}. */
export async function scan(projectDir, target, { json = false } = {}) {
	if (!target) return { code: 2, text: "Give a URL (http://localhost:3000/page) or an HTML file to scan." };
	const cfg = loadA11yConfig(projectDir);
	const pw = await projectImport(projectDir, ["@playwright/test", "playwright"]);
	const axe = await projectImport(projectDir, ["@axe-core/playwright"]);
	if (!pw || !axe) {
		const missing = [!pw && "playwright (or @playwright/test)", !axe && "@axe-core/playwright"].filter(Boolean).join(" and ");
		return { code: 3, text: `Scan skipped — ${missing} isn't installed in this project. To scan pages: npm install --save-dev @playwright/test @axe-core/playwright && npx playwright install chromium\nUntil then, a code review (the a11y-reviewer agent) still works.` };
	}
	let url = target;
	if (!/^https?:\/\//.test(target)) {
		const file = path.resolve(projectDir, target);
		if (!existsSync(file)) return { code: 2, text: `${target} isn't a URL or a file in this project.` };
		url = pathToFileURL(file).href;
	}
	const chromium = pw.mod.chromium ?? pw.mod.default?.chromium;
	const AxeBuilder = axe.mod.AxeBuilder ?? axe.mod.default;
	let browser;
	try {
		browser = await chromium.launch();
	} catch (e) {
		return { code: 2, text: `Couldn't start Chromium (${String(e.message).split("\n")[0]}). Install the browser: npx playwright install chromium` };
	}
	try {
		const page = await (await browser.newContext()).newPage(); // AxeBuilder needs a page from a context
		await page.goto(url, { waitUntil: "load" });
		const tags = axeTags(cfg.wcag, cfg.level);
		const results = await new AxeBuilder({ page }).withTags(tags).analyze();
		const head = `Scanned ${url} with axe (WCAG ${cfg.wcag} ${cfg.level}: ${tags.join(", ")})${cfg.warning ? `\n(${cfg.warning})` : ""}.`;
		const body = json ? JSON.stringify(results.violations, null, 2) : formatViolations(results);
		const tail = "Automated checks find only part of WCAG; keyboard use, focus order, screen-reader flow and whether labels make sense still need a person.";
		return { code: results.violations.length ? 1 : 0, text: `${head}\n\n${body}\n\n${tail}`, results };
	} catch (e) {
		return { code: 2, text: `The scan failed: ${String(e.message).split("\n")[0]}` };
	} finally {
		await browser.close();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const r = await scan(process.env.CLAUDE_PROJECT_DIR || process.cwd(), args.find((a) => !a.startsWith("--")), { json: args.includes("--json") });
	console.log(r.text);
	process.exit(r.code);
}
