#!/usr/bin/env node
// guardrails PostToolUse hook on Edit | Write | MultiEdit (opt-in, "lint": true): lints the edited file.
// "lintCommand" in .claude/guardrails.json ({file} = the edited file), else the project's own ESLint for
// JS/TS files. Failures go back to Claude (exit 2); no linter → says lint was skipped. Skips files the qa
// plugin's test-file hook already lints when that hook is on in this project. 60 s cap; no network.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { finish, loadConfig, projectDirOf, readInput } from "./lib.mjs";

const CAP_MS = 60_000;
const JS_TS = /\.(c|m)?(j|t)sx?$/;
const QA_TEST_FILE = /\.(spec|test)\.(ts|js|mjs|cjs)$/;

/** Is the qa plugin's test-file hook on here, and is this one of its files? Then guardrails leaves it. */
export function qaCovers(file, projectDir) {
	if (!QA_TEST_FILE.test(file)) return false;
	try {
		const qa = JSON.parse(readFileSync(path.join(projectDir, ".claude", "qa.json"), "utf8"));
		return qa.version === 1 && qa.hooks?.lintAfterEdit === true;
	} catch {
		return false;
	}
}

function localEslint(projectDir) {
	const bin = path.join(projectDir, "node_modules", ".bin", process.platform === "win32" ? "eslint.cmd" : "eslint");
	return existsSync(bin) ? bin : null;
}

/** The whole hook, as data. */
export function lintAfterEdit(input, env = process.env, now = Date.now) {
	const started = now();
	const projectDir = projectDirOf(input, env);
	const cfg = loadConfig(projectDir, env);
	const file = input?.tool_input?.file_path;
	if (!cfg.on.lint || !file) return { exit: 0 };
	const abs = path.resolve(projectDir, file);
	const rel = path.relative(projectDir, abs);
	if (qaCovers(rel, projectDir)) return { exit: 0 };
	let result;
	if (cfg.lintCommand) {
		const cmd = cfg.lintCommand.replaceAll("{file}", JSON.stringify(rel));
		result = spawnSync(cmd, { cwd: projectDir, encoding: "utf8", shell: true, timeout: CAP_MS });
	} else if (JS_TS.test(rel)) {
		const eslint = localEslint(projectDir);
		if (!eslint) return { exit: 0, json: { systemMessage: `guardrails: lint skipped for ${rel} — no lintCommand set and eslint isn't installed in this project` } };
		result = spawnSync(eslint, [rel], { cwd: projectDir, encoding: "utf8", timeout: CAP_MS, shell: process.platform === "win32" });
	} else {
		return { exit: 0 }; // not a JS/TS file and no lintCommand: nothing to lint
	}
	const took = `${((now() - started) / 1000).toFixed(1)}s`;
	if (result.error && result.error.code === "ETIMEDOUT") return { exit: 0, json: { systemMessage: `guardrails: lint stopped for ${rel} — the 60s cap was reached` } };
	if (result.status === 0) return { exit: 0 };
	const out = `${result.stdout || ""}${result.stderr || ""}`.trim().slice(0, 4000);
	return { exit: 2, stderr: `guardrails lint: ${rel} (${took})\n${out}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) finish(lintAfterEdit(await readInput()));
