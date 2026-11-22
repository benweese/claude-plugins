#!/usr/bin/env node
// Plain-git pre-commit scanner, installed by `install-privacy-git-hook` into <hooks dir>/privacy/ with
// detectors.mjs and commit-content.mjs next to it. Reads .claude/privacy.json and the denylist at commit
// time (no values are stored here). Exit 1 blocks the commit; values are never printed.
import { spawnSync } from "node:child_process";
import { addedLines } from "./commit-content.mjs";
import { formatFindings, loadDenylist, loadPrivacyConfig, scanChunks } from "./detectors.mjs";

const root = (spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout || "").trim() || process.cwd();
const cfg = loadPrivacyConfig(root);
if (cfg.warning) console.error(cfg.warning);
if (!cfg.commitHook) process.exit(0); // not opted in: .claude/privacy.json "commitHook": true
const diff = spawnSync("git", ["diff", "--cached", "-U0", "--no-color"], { cwd: root, encoding: "utf8" }).stdout || "";
const { entries, notes } = loadDenylist(root, cfg);
for (const n of notes) console.error(`privacy: ${n}`);
const findings = scanChunks(addedLines(diff), cfg, entries);
if (findings.length) {
	console.error(`privacy: commit blocked — it would commit what looks like personal data (values hidden):\n${formatFindings(findings)}\nRemove it, or allowlist it in .claude/privacy.json. (git commit --no-verify skips this check.)`);
	process.exit(1);
}
