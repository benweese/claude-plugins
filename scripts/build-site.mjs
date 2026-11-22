// Builds the GitHub Pages site (code.benweese.com/<repo name>/) from the repo's Markdown, rendered by GitHub's own
// Markdown API so it matches github.com. No dependencies. Pages come from .claude-plugin/marketplace.json: every
// plugin gets its README, its CHANGELOG and any plugins/<name>/docs/*.md, so a new plugin gets pages with no edit here.
//
//   node scripts/build-site.mjs [outDir]     (default _site; GITHUB_TOKEN raises the API rate limit)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "benweese/playwright-ai-qa-agents";
const NAME = REPO.split("/")[1];
const BASE = `https://code.benweese.com/${NAME}/`;
const BLOB = `https://github.com/${REPO}/blob/main/`;

/** Every page: {source, file, nav, group}. group = the plugin a page belongs to (its sub-nav), or null. */
export function sitePages(root = ".") {
	const market = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
	const pages = [{ source: "README.md", file: "index.html", nav: "Overview", group: null }];
	for (const p of market.plugins) {
		const dir = p.source.replace(/^\.\//, "");
		pages.push({ source: `${dir}/README.md`, file: `${p.name}.html`, nav: p.name, group: p.name });
		if (existsSync(path.join(root, dir, "CHANGELOG.md"))) pages.push({ source: `${dir}/CHANGELOG.md`, file: `${p.name}-changelog.html`, nav: "Changelog", group: p.name });
		const docs = path.join(root, dir, "docs");
		if (existsSync(docs)) {
			for (const f of readdirSync(docs).filter((x) => x.endsWith(".md")).sort()) {
				const slug = f.replace(/\.md$/, "");
				pages.push({ source: `${dir}/docs/${f}`, file: `${p.name}-${slug}.html`, nav: slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), group: p.name });
			}
		}
	}
	pages.push({ source: "CHANGELOG.md", file: "changelog-marketplace.html", nav: "Marketplace changelog", group: null });
	pages.push({ source: "docs/marketplace-plan.md", file: "plan.html", nav: "Plan", group: null });
	return pages;
}

/** Old page names → where they live now (each gets a small redirect page). */
export const MOVED = { "changelog.html": "qa-changelog.html", "worked-example.html": "qa-worked-example.html" };

let PAGES = [];
let pageFor = new Map();

async function render(markdown) {
	const headers = { "content-type": "application/json", "user-agent": `${NAME} site build` };
	if (process.env.GITHUB_TOKEN) {
		headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	}
	const response = await fetch("https://api.github.com/markdown", {
		method: "POST",
		headers,
		body: JSON.stringify({ text: markdown, mode: "gfm", context: REPO })
	});
	if (!response.ok) {
		throw new Error(`GitHub Markdown API: ${response.status} ${await response.text()}`);
	}
	return response.text();
}

/** Points a relative link at its page on this site, or at the file on GitHub. */
export function rewriteLink(href, source) {
	if (/^([a-z]+:|#|\/\/)/i.test(href)) {
		return href;
	}
	const [target, hash = ""] = href.split("#");
	const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
	const local = pageFor.get(resolved);
	return local ? `${local}${hash ? `#${hash}` : ""}` : `${BLOB}${resolved}${hash ? `#${hash}` : ""}`;
}

function tidy(html, source) {
	return (
		html
			// GitHub prefixes heading ids with "user-content-" and fixes #links up with script.
			.replace(/id="user-content-/g, 'id="')
			.replace(/href="([^"]*)"/g, (_, href) => `href="${rewriteLink(href, source)}"`)
			.replace(/src="(?!https?:)([^"]*)"/g, (_, src) => `src="https://raw.githubusercontent.com/${REPO}/main/${src}"`)
	);
}

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function layout({ title, description, body, current }) {
	const here = PAGES.find((p) => p.file === current);
	const link = (p, label = p.nav) => `<a href="${p.file}"${p.file === current ? ' aria-current="page"' : ""}>${label}</a>`;
	// Top row: the overview, one link per plugin (its README), the marketplace changelog and the plan.
	// On a plugin's changelog or docs page, its README link is marked as the current section.
	const top = (p) => (p.file !== current && here?.group && p.file === `${here.group}.html` ? `<a href="${p.file}" aria-current="true">${p.nav}</a>` : link(p));
	const nav = PAGES.filter((p) => !p.group || p.file === `${p.group}.html`).map(top).join("");
	// Second row on a plugin's pages: its README, changelog and docs.
	const group = here?.group ? PAGES.filter((p) => p.group === here.group) : [];
	const sub = group.length > 1 ? `\n<nav class="pages sub" aria-label="${here.group} pages"><span class="name">${here.group}</span>${group.map((p) => link(p, p.file === `${p.group}.html` ? "README" : p.nav)).join("")}</nav>` : "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="canonical" href="${BASE}${current === "index.html" ? "" : current}">
<meta name="color-scheme" content="dark">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="stylesheet" href="site.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
<a class="home" href="https://benweese.com/">Ben Weese · benweese.com</a>
<a href="https://code.benweese.com/">All projects</a>
</header>
<nav class="pages" aria-label="Documentation">
<span class="name">${NAME}</span>${nav}<a href="https://github.com/${REPO}">GitHub</a>
</nav>${sub}
<main id="main" class="markdown-body" tabindex="-1">
${body}
</main>
<footer class="footer">
<a href="https://benweese.com/">benweese.com</a> · <a href="https://code.benweese.com/">All projects</a> ·
<a href="https://github.com/${REPO}">Source</a>
</footer>
<script type="module">
const blocks = document.querySelectorAll('pre[lang="mermaid"]');
if (blocks.length) {
	const { default: mermaid } = await import("https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs");
	mermaid.initialize({ startOnLoad: false, theme: "dark" });
	blocks.forEach((pre) => {
		const div = document.createElement("div");
		div.className = "mermaid";
		div.textContent = pre.textContent;
		pre.replaceWith(div);
	});
	await mermaid.run();
}
</script>
</body>
</html>
`;
}

/** A page that sends the visitor (and search engines) to a page's new name. */
const redirect = (to) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Moved</title>
<meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${BASE}${to}"></head>
<body><p>This page moved to <a href="${to}">${to}</a>.</p></body></html>
`;

async function main(out) {
	PAGES = sitePages();
	pageFor = new Map(PAGES.map((p) => [p.source, p.file]));
	await mkdir(out, { recursive: true });
	for (const page of PAGES) {
		const markdown = await readFile(page.source, "utf8");
		const heading = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? page.nav;
		const firstParagraph = markdown.split(/\n\s*\n/).find((p) => /^[A-Za-z]/.test(p.trim())) ?? "";
		const description = firstParagraph
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/[`*_]/g, "")
			.replace(/\s+/g, " ")
			.slice(0, 200);
		const title = page.file === "index.html" ? `${heading} · Ben Weese` : `${heading} · ${NAME}`;
		const body = tidy(await render(markdown), page.source);
		await writeFile(path.join(out, page.file), layout({ title, description, body, current: page.file }));
		console.log(`${page.source} → ${path.join(out, page.file)}`);
	}
	for (const [from, to] of Object.entries(MOVED)) await writeFile(path.join(out, from), redirect(to));
	await writeFile(path.join(out, "site.css"), await readFile("scripts/site.css", "utf8"));
}

/** For tests: set the page list without building. */
export function usePages(pages) {
	PAGES = pages;
	pageFor = new Map(pages.map((p) => [p.source, p.file]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2] ?? "_site");
