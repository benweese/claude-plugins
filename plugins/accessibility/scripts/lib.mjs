// Shared pieces for the accessibility plugin: project config, WCAG tags, contrast math, scan formatting.
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * .claude/a11y.json ("version": 1). Missing or invalid → WCAG 2.2 AA defaults (warning says why when invalid).
 * @return {{level: "A"|"AA"|"AAA", wcag: string, projectList: ?string, warning: ?string}}
 */
export function loadA11yConfig(projectDir) {
	const out = { level: "AA", wcag: "2.2", projectList: null, warning: null };
	let raw;
	try {
		raw = readFileSync(path.join(projectDir, ".claude", "a11y.json"), "utf8");
	} catch {
		return out;
	}
	let c;
	try {
		c = JSON.parse(raw);
	} catch {
		c = null;
	}
	if (!c || typeof c !== "object" || c.version !== 1) {
		out.warning = "a11y: .claude/a11y.json is invalid (needs valid JSON with \"version\": 1) — using WCAG 2.2 AA";
		return out;
	}
	if (["A", "AA", "AAA"].includes(c.level)) out.level = c.level;
	if (["2.0", "2.1", "2.2"].includes(String(c.wcag))) out.wcag = String(c.wcag);
	if (typeof c.projectList === "string" && c.projectList.trim()) out.projectList = c.projectList.trim();
	return out;
}

/** axe tags for a WCAG version + level, e.g. 2.2 AA → wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa. */
export function axeTags(wcag = "2.2", level = "AA") {
	const versions = ["2", "21", "22"].slice(0, { "2.0": 1, "2.1": 2, "2.2": 3 }[wcag] ?? 3);
	const levels = { A: ["a"], AA: ["a", "aa"], AAA: ["a", "aa", "aaa"] }[level] ?? ["a", "aa"];
	return versions.flatMap((v) => levels.map((l) => `wcag${v}${l}`));
}

/** "#16181d", "#fff", "rgb(22, 24, 29)" → [r, g, b] (0–255), or null. */
export function parseColor(text) {
	const s = String(text).trim().toLowerCase();
	let m = /^#([0-9a-f]{3})$/.exec(s);
	if (m) return m[1].split("").map((c) => parseInt(c + c, 16));
	m = /^#([0-9a-f]{6})$/.exec(s);
	if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
	m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/.exec(s);
	if (m) return [m[1], m[2], m[3]].map(Number).every((n) => n <= 255) ? [m[1], m[2], m[3]].map(Number) : null;
	return null;
}

/** WCAG relative luminance. */
export function luminance([r, g, b]) {
	const ch = (v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Contrast ratio of two colors (1–21). */
export function contrastRatio(a, b) {
	const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}

/** Pass/fail per use for a ratio at a level (WCAG 1.4.3 / 1.4.6 text, 1.4.11 non-text). */
export function contrastVerdict(ratio, level = "AA") {
	const aaa = level === "AAA";
	return {
		text: ratio >= (aaa ? 7 : 4.5),
		largeText: ratio >= (aaa ? 4.5 : 3),
		uiAndGraphics: ratio >= 3
	};
}

/** axe results → plain-English report lines (one block per violation). */
export function formatViolations(results, { maxNodes = 5 } = {}) {
	const v = results.violations || [];
	if (!v.length) return "No automated violations found.";
	const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
	return v
		.slice()
		.sort((a, b) => (order[a.impact] ?? 9) - (order[b.impact] ?? 9))
		.map((x) => {
			const wcag = (x.tags || []).filter((t) => /^wcag\d/.test(t)).join(", ");
			const nodes = (x.nodes || []).slice(0, maxNodes).map((n) => `    - ${[].concat(n.target).join(" ")}\n      ${String(n.html || "").slice(0, 160)}\n      ${String(n.failureSummary || "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ")}`);
			const more = (x.nodes || []).length > maxNodes ? `\n    …and ${x.nodes.length - maxNodes} more` : "";
			return `[${x.impact || "?"}] ${x.help} (${x.id}${wcag ? `; ${wcag}` : ""})\n  ${x.helpUrl || ""}\n${nodes.join("\n")}${more}`;
		})
		.join("\n\n");
}
