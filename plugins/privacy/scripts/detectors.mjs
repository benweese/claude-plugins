// Personal-data detectors for the privacy plugin. Self-contained (Node built-ins only), so the plain-git
// hook installer can copy it next to the installed pre-commit hook. Never prints a matched value.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const CACHE_FILE = ".claude/privacy/denylist.cache";
export const CACHE_MAX_AGE_DAYS = 7;

/**
 * The project's privacy settings from .claude/privacy.json ("version": 1). Missing or invalid → the commit
 * hook is off (and `warning` says why when the file exists but is invalid).
 * @return {{valid: boolean, commitHook: boolean, dollarAmounts: boolean, patterns: Array<{name, re}>, denylist: ?string, allowlist: Array<string|RegExp>, warning: ?string}}
 */
export function loadPrivacyConfig(projectDir) {
	const out = { valid: false, commitHook: false, dollarAmounts: false, patterns: [], denylist: null, allowlist: [], warning: null };
	let raw;
	try {
		raw = readFileSync(path.join(projectDir, ".claude", "privacy.json"), "utf8");
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
		out.warning = "privacy: .claude/privacy.json is invalid (needs valid JSON with \"version\": 1) — the commit check is off";
		return out;
	}
	out.valid = true;
	out.commitHook = c.commitHook === true;
	out.dollarAmounts = c.dollarAmounts === true;
	out.denylist = typeof c.denylist === "string" && c.denylist.trim() ? c.denylist.trim() : null;
	for (const p of Array.isArray(c.patterns) ? c.patterns : []) {
		try {
			if (p && typeof p.regex === "string") out.patterns.push({ name: String(p.name || "custom pattern"), re: new RegExp(p.regex, p.flags || "") });
		} catch {
			out.warning = `privacy: custom pattern "${p.name || p.regex}" isn't a valid regular expression — skipped`;
		}
	}
	for (const a of Array.isArray(c.allowlist) ? c.allowlist : []) {
		const m = typeof a === "string" ? /^\/(.+)\/([a-z]*)$/.exec(a) : null;
		try {
			if (m) out.allowlist.push(new RegExp(m[1], m[2]));
			else if (typeof a === "string") out.allowlist.push(a);
		} catch {
			/* bad allowlist regex: ignored */
		}
	}
	return out;
}

/** Luhn checksum for a digit string. */
export function luhn(digits) {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 1) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	}
	return sum % 10 === 0;
}

const SAFE_EMAIL = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|[\w-]+\.(?:invalid|test|example|localhost))$|^(?:no-?reply|donotreply)@|@users\.noreply\.github\.com$/i;

/** The built-in detectors: [{name, find(line) → array of matched strings}]. */
export function builtInDetectors({ dollarAmounts = false } = {}) {
	const list = [
		{ name: "email address", find: (l) => (l.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter((e) => !SAFE_EMAIL.test(e)) },
		{
			name: "card number",
			find: (l) => (l.match(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g) || []).filter((m) => {
				const d = m.replace(/[ -]/g, "");
				return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d);
			})
		},
		{ name: "SSN-like number", find: (l) => (l.match(/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g) || []).filter((s) => !/^(000|666|9\d\d)-/.test(s) && !/-00-|-0000$/.test(s)) },
		{
			name: "US phone number",
			find: (l) => (l.match(/(?<![\d-])(?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\d-])/g) || []).filter((p) => !/555[ .-]01\d\d$/.test(p))
		}
	];
	if (dollarAmounts) list.push({ name: "dollar amount", find: (l) => l.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) || [] });
	return list;
}

/** Denylist text → entries ({value, re}); one per line, # comments. Words match whole words; numbers need digit boundaries. */
export function parseDenylist(text) {
	const out = [];
	for (const raw of String(text || "").split("\n")) {
		const v = raw.replace(/\s+#.*$/, "").trim();
		if (!v || v.startsWith("#")) continue;
		const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
		const startWord = /^[A-Za-z]/.test(v) ? "(?<![A-Za-z0-9_])" : /^\d/.test(v) ? "(?<!\\d)" : "";
		const endWord = /[A-Za-z]$/.test(v) ? "(?![A-Za-z0-9_])" : /\d$/.test(v) ? "(?!\\d)" : "";
		out.push({ re: new RegExp(`${startWord}${esc}${endWord}`, "i") });
	}
	return out;
}

/** Longest `git check-ignore` may take: it only decides whether to add a note. */
const CHECK_IGNORE_MS = 5_000;

/**
 * Is the path gitignored in this repo? (null = not a git repo / can't tell, including no time left or a timeout)
 * @param {{left: () => number}} [budget] the hook's scan budget (scanBudget() in commit-content.mjs)
 */
export function isGitignored(repo, file, budget) {
	const timeout = Math.min(CHECK_IGNORE_MS, budget ? budget.left() : CHECK_IGNORE_MS);
	if (timeout <= 0) return null;
	const r = spawnSync("git", ["check-ignore", "-q", file], { cwd: repo, timeout, killSignal: "SIGKILL" });
	if (r.status === 0) return true;
	if (r.status === 1) return false;
	return null;
}

/**
 * Loads the denylist: a local path, or the cache of a URL (`/privacy-scan refresh` downloads it; hooks never
 * fetch). Returns entries and notes (missing / stale / not gitignored) — never a silent skip. budget (optional) bounds
 * the gitignore check.
 */
export function loadDenylist(projectDir, cfg, nowMs = Date.now(), budget) {
	const notes = [];
	if (!cfg.denylist) return { entries: [], notes };
	const isUrl = /^(?:https?:\/\/|gh:)/.test(cfg.denylist);
	const file = isUrl ? path.join(projectDir, CACHE_FILE) : path.resolve(projectDir, cfg.denylist);
	if (!existsSync(file)) {
		notes.push(isUrl ? "denylist skipped — no cached copy yet (run /privacy-scan refresh)" : `denylist skipped — ${cfg.denylist} not found`);
		return { entries: [], notes };
	}
	if (isUrl) {
		const days = (nowMs - statSync(file).mtimeMs) / 86_400_000;
		if (days > CACHE_MAX_AGE_DAYS) notes.push(`denylist cache is ${Math.floor(days)} days old — run /privacy-scan refresh`);
	}
	const inside = !path.relative(projectDir, file).startsWith("..");
	if (inside && isGitignored(projectDir, path.relative(projectDir, file), budget) === false) {
		notes.push(`${path.relative(projectDir, file)} isn't gitignored — it holds the values you're protecting; add it to .gitignore`);
	}
	return { entries: parseDenylist(readFileSync(file, "utf8")), notes };
}

const allowed = (value, allowlist) => allowlist.some((a) => (typeof a === "string" ? value.toLowerCase() === a.toLowerCase() : a.test(value)));

/**
 * Scans chunks ([{file, lines: [{n, text}]}]). Findings never include the matched value.
 * @return {Array<{file, line, detector}>}
 */
export function scanChunks(chunks, cfg, denylist = []) {
	const detectors = builtInDetectors(cfg).concat(cfg.patterns.map((p) => ({ name: p.name, find: (l) => l.match(new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`)) || [] })));
	const out = [];
	for (const c of chunks) {
		for (const l of c.lines) {
			for (const d of detectors) {
				if (d.find(l.text).some((v) => !allowed(v, cfg.allowlist))) out.push({ file: c.file, line: l.n, detector: d.name });
			}
			denylist.forEach((e, i) => {
				const m = e.re.exec(l.text);
				if (m && !allowed(m[0], cfg.allowlist)) out.push({ file: c.file, line: l.n, detector: `denylist entry ${i + 1}` });
			});
		}
	}
	return out;
}

/** One report line per finding (values hidden). */
export const formatFindings = (findings, max = 30) =>
	findings.slice(0, max).map((f) => `  ${f.file}:${f.line}  ${f.detector}`).join("\n") + (findings.length > max ? `\n  …and ${findings.length - max} more` : "");
