// "What will this command commit?" — shared by the guardrails and privacy plugins.
// SOURCE OF TRUTH: shared/commit-content.mjs in the plugins repo. It is copied byte-for-byte into
// plugins/guardrails/scripts/ and plugins/privacy/scripts/ by `node scripts/sync-shared.mjs`
// (plugins install separately, so they can't import each other). A test fails if a copy differs:
// edit the source, then run the sync script.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Splits a shell command line into simple commands at && || ; | and newlines (quotes respected). */
export function splitCommands(line) {
	const parts = [];
	let cur = "";
	let q = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (q) {
			cur += ch;
			if (ch === q) q = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			q = ch;
			cur += ch;
			continue;
		}
		const two = line.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			parts.push(cur);
			cur = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "\n") {
			parts.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	parts.push(cur);
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** Words of a simple command (quotes removed; good enough for flags and paths). */
export function words(cmd) {
	const out = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m;
	while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

/** For `git [-C dir] [-c k=v] <sub> …`: { sub, args } — or null if it isn't git. */
export function gitSub(cmd) {
	const w = words(cmd);
	let i = 0;
	while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++; // leading VAR=value
	if (w[i] !== "git") return null;
	i++;
	while (i < w.length && w[i].startsWith("-")) i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
	return w[i] ? { sub: w[i], args: w.slice(i + 1) } : null;
}

/** Runs git in a folder; returns stdout ("" on error). */
export function git(cwd, args) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return r.status === 0 ? r.stdout : "";
}

/** What a command line will commit: {commit, all, addAll, addPaths, addTracked}. */
export function commitPlan(line) {
	const plan = { commit: false, all: false, addAll: false, addTracked: false, addPaths: [] };
	for (const seg of splitCommands(line)) {
		const g = gitSub(seg);
		if (!g) continue;
		if (g.sub === "add") {
			for (const a of g.args) {
				if (a === "-A" || a === "--all" || a === ".") plan.addAll = true;
				else if (a === "-u" || a === "--update") plan.addTracked = true;
				else if (!a.startsWith("-")) plan.addPaths.push(a);
			}
		}
		if (g.sub === "commit") {
			plan.commit = true;
			for (const a of g.args) if (a === "--all" || /^-[A-Za-z]*a[A-Za-z]*$/.test(a)) plan.all = true;
			break; // later segments run after the commit
		}
	}
	return plan;
}

/** Added lines per file from a unified diff (-U0): [{file, lines: [{n, text}]}]. */
export function addedLines(diff) {
	const files = [];
	let cur = null;
	let n = 0;
	for (const l of diff.split("\n")) {
		if (l.startsWith("+++ ")) {
			const f = l.slice(4).replace(/^b\//, "");
			cur = f === "/dev/null" ? null : { file: f, lines: [] };
			if (cur) files.push(cur);
		} else if (l.startsWith("@@")) {
			const m = /\+(\d+)/.exec(l);
			n = m ? Number(m[1]) : 0;
		} else if (cur && l.startsWith("+")) {
			cur.lines.push({ n: n++, text: l.slice(1) });
		} else if (cur && !l.startsWith("-") && !l.startsWith("\\")) {
			n++;
		}
	}
	return files;
}

/** Everything the commit will contain, as [{file, lines:[{n,text}]}]. */
export function contentToCommit(repo, plan) {
	const chunks = addedLines(git(repo, ["diff", "--cached", "-U0", "--no-color"]));
	const tracked = plan.all || plan.addAll || plan.addTracked ? [] : plan.addPaths;
	if (plan.all || plan.addAll || plan.addTracked || plan.addPaths.length) {
		const args = ["diff", "-U0", "--no-color"];
		if (!(plan.all || plan.addAll || plan.addTracked)) args.push("--", ...tracked);
		chunks.push(...addedLines(git(repo, args)));
	}
	if (plan.addAll || plan.addPaths.length) {
		const args = ["ls-files", "--others", "--exclude-standard"];
		if (!plan.addAll) args.push("--", ...plan.addPaths);
		for (const f of git(repo, args).split("\n").filter(Boolean)) {
			const abs = path.join(repo, f);
			try {
				if (statSync(abs).size > 1_000_000) continue;
				const text = readFileSync(abs, "utf8");
				if (text.includes("\u0000")) continue; // binary
				chunks.push({ file: f, lines: text.split("\n").map((t, i) => ({ n: i + 1, text: t })) });
			} catch {
				/* unreadable: skip */
			}
		}
	}
	return chunks;
}
