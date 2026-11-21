#!/usr/bin/env node
// qa hook (PostToolUse on Edit | Write | MultiEdit): after a Playwright test file is edited, lint that
// file with the repo's ESLint and check Playwright still loads it (`playwright test --list <file>`).
//
// Opt-in per project: does nothing unless .claude/qa.json is { "version": 1, "hooks": { "lintAfterEdit": true } }.
// A missing or invalid config = off. No network: only the project's own node_modules/.bin tools.
//   exit 0           nothing to do, or both checks passed (a short note with the elapsed time)
//   exit 0 + note    a check was skipped (tool not installed, or the 60 s cap) — never a silent pass
//   exit 2           ESLint or --list failed; stderr goes back to Claude to fix (the edit stays)
// Hook input/output: https://code.claude.com/docs/en/hooks
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TEST_FILE = /\.(spec|test)\.(ts|js|mjs|cjs)$/;
export const CONFIG_NAMES = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs"];
export const CAP_MS = 60_000;
const MAX_OUTPUT = 4000;

/** Is the project opted in? Reads <project>/.claude/qa.json; anything missing or malformed = off. */
export function hookEnabled(projectDir) {
	let config;
	try {
		config = JSON.parse(readFileSync(path.join(projectDir, ".claude", "qa.json"), "utf8"));
	} catch {
		return false;
	}
	return Boolean(config && config.version === 1 && config.hooks && config.hooks.lintAfterEdit === true);
}

/** The nearest folder at or above the file's folder (but not above the project root) with a playwright.config.*. */
export function findPlaywrightRoot(filePath, projectDir) {
	const root = path.resolve(projectDir);
	let dir = path.dirname(path.resolve(filePath));
	if (dir !== root && !dir.startsWith(root + path.sep)) return null; // outside the project
	for (;;) {
		if (CONFIG_NAMES.some((name) => existsSync(path.join(dir, name)))) return dir;
		if (dir === root) return null;
		dir = path.dirname(dir);
	}
}

/** The project's own binary (node_modules/.bin, walking up to the project root), or null. Never downloads. */
export function localBin(name, fromDir, projectDir) {
	const root = path.resolve(projectDir);
	const file = process.platform === "win32" ? `${name}.cmd` : name;
	let dir = path.resolve(fromDir);
	for (;;) {
		const candidate = path.join(dir, "node_modules", ".bin", file);
		if (existsSync(candidate)) return candidate;
		if (dir === root || path.dirname(dir) === dir) return null;
		dir = path.dirname(dir);
	}
}

const trim = (text) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (cut)` : text).trim();
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

function run(bin, args, cwd, budgetMs) {
	const result = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: Math.max(budgetMs, 1), shell: process.platform === "win32" });
	const timedOut = result.error && result.error.code === "ETIMEDOUT";
	return { ok: result.status === 0, timedOut, output: trim(`${result.stdout || ""}${result.stderr || ""}`) };
}

/**
 * The whole check, as data (so tests can call it without a child process).
 * @param {object} input Hook input from stdin. @param {object} env process.env.
 * @return {{exit: number, stderr?: string, note?: string}}
 */
export function check(input, env = process.env, now = Date.now) {
	const started = now();
	const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
	const filePath = input?.tool_input?.file_path;
	if (!filePath || !TEST_FILE.test(filePath)) return { exit: 0 };
	if (!hookEnabled(projectDir)) return { exit: 0 };
	const absFile = path.resolve(projectDir, filePath);
	const pwRoot = findPlaywrightRoot(absFile, projectDir);
	if (!pwRoot) return { exit: 0 }; // not a Playwright repo (or folder): nothing to check
	const rel = path.relative(pwRoot, absFile);
	const label = path.relative(projectDir, absFile);
	const skipped = [];
	const failed = [];
	const budget = () => CAP_MS - (now() - started);

	const steps = [
		{ name: "eslint", bin: localBin("eslint", pwRoot, projectDir), args: [rel], missing: "lint skipped — eslint isn't installed in this project" },
		{ name: "playwright test --list", bin: localBin("playwright", pwRoot, projectDir), args: ["test", "--list", rel], missing: "--list skipped — @playwright/test isn't installed in this project" }
	];
	for (const step of steps) {
		if (budget() <= 0) {
			skipped.push(`${step.name} skipped — the ${CAP_MS / 1000}s cap was reached`);
			continue;
		}
		if (!step.bin) {
			skipped.push(step.missing);
			continue;
		}
		const result = run(step.bin, step.args, pwRoot, budget());
		if (result.timedOut) skipped.push(`${step.name} stopped — the ${CAP_MS / 1000}s cap was reached`);
		else if (!result.ok) failed.push(`✗ ${step.name}\n${result.output}`);
	}
	const took = seconds(now() - started);
	if (failed.length) {
		const notes = skipped.length ? `\n${skipped.map((s) => `(${s})`).join("\n")}` : "";
		return { exit: 2, stderr: `qa hook: ${label} (${took}, in ${path.relative(projectDir, pwRoot) || "."})\n${failed.join("\n\n")}${notes}` };
	}
	if (skipped.length) return { exit: 0, note: `qa hook: ${label} (${took}) — ${skipped.join("; ")}` };
	return { exit: 0, note: `qa hook: ${label} — lint + --list OK (${took})` };
}

async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	let input;
	try {
		input = JSON.parse(raw || "{}");
	} catch {
		process.exit(0); // not hook input: nothing to do
	}
	const result = check(input);
	if (result.stderr) process.stderr.write(`${result.stderr}\n`);
	if (result.note) process.stdout.write(`${JSON.stringify({ systemMessage: result.note })}\n`);
	process.exit(result.exit);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
