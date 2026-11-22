// The saved original request for a test task: .claude/qa/requirements.md — the ONLY source of truth for
// /review-tests (a plan is written by the authoring agent, so it's used to map ids, never as the requirement).
//
// File format (the contract: any skill or plugin that writes this format is a requirement source):
//   <!-- qa-requirements v1 -->
//   source: chat | issue | file | <your source name>
//   ref: <issue number, path, …>            (optional)
//   branch: <git branch when saved>
//   saved: <ISO date>
//   ---
//   <the request, verbatim>
// Task id = sha256(branch + "\n" + body): a new request or a different branch is a new task.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REQ_FILE = ".claude/qa/requirements.md";
export const STATE_FILE = ".claude/qa/review-state.json";
const MARK = "<!-- qa-requirements v1 -->";

const git = (cwd, args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : null;
};

/** The current git branch (or "(no git)"). */
export const currentBranch = (root) => git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || "(no git)";

/** Is the file gitignored? true / false / null (not a git repo). */
export function isIgnored(root, rel) {
	const r = spawnSync("git", ["check-ignore", "-q", rel], { cwd: root });
	return r.status === 0 ? true : r.status === 1 ? false : null;
}

/** The warning shown on every run when requirements.md isn't gitignored (or null). */
export function ignoreWarning(root) {
	return isIgnored(root, REQ_FILE) === false ? `qa: ${REQ_FILE} isn't gitignored — it holds the original request; add ".claude/qa/" to .gitignore` : null;
}

export const taskId = (branch, body) => createHash("sha256").update(`${branch}\n${body}`).digest("hex").slice(0, 16);

/** Writes requirements.md. Returns {file, task, branch}. */
export function saveRequirements(root, { source, ref = "", text }) {
	const body = String(text ?? "").replace(/\s+$/, "");
	if (!body) throw new Error("The requirement is empty — nothing saved.");
	const branch = currentBranch(root);
	const file = path.join(root, REQ_FILE);
	mkdirSync(path.dirname(file), { recursive: true });
	const head = [MARK, `source: ${source}`, ref ? `ref: ${ref}` : null, `branch: ${branch}`, `saved: ${new Date().toISOString()}`, "---"].filter(Boolean).join("\n");
	writeFileSync(file, `${head}\n${body}\n`);
	return { file: REQ_FILE, task: taskId(branch, body), branch };
}

/** Reads requirements.md → {source, ref, branch, saved, body, task} or null (missing / not in the format). */
export function readRequirements(root) {
	const file = path.join(root, REQ_FILE);
	if (!existsSync(file)) return null;
	const text = readFileSync(file, "utf8");
	if (!text.startsWith(MARK)) return null;
	const sep = text.indexOf("\n---\n");
	if (sep === -1) return null;
	const meta = Object.fromEntries(text.slice(MARK.length, sep).split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
	const body = text.slice(sep + 5).replace(/\s+$/, "");
	return { source: meta.source, ref: meta.ref || "", branch: meta.branch, saved: meta.saved, body, task: taskId(meta.branch, body) };
}

/** A GitHub issue's text (title, body — acceptance criteria included) via gh. */
export function issueText(root, ref) {
	const r = spawnSync("gh", ["issue", "view", String(ref), "--json", "number,title,body,url"], { cwd: root, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`gh couldn't read issue ${ref}: ${(r.stderr || "").trim() || "is gh installed and logged in?"}`);
	const i = JSON.parse(r.stdout);
	return `# ${i.title} (#${i.number})\n${i.url}\n\n${i.body || ""}`;
}

/** Review state: {task, reviewedHash, autoCount}. */
export function readState(root) {
	try {
		return JSON.parse(readFileSync(path.join(root, STATE_FILE), "utf8"));
	} catch {
		return null;
	}
}

export function writeState(root, state) {
	const file = path.join(root, STATE_FILE);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(state, null, "\t")}\n`);
}

/** A hash of every test file's content (tracked + untracked, not ignored). */
export function testFilesHash(root) {
	const listed = (git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]) || "").split("\n");
	const files = listed.filter((f) => /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)).sort();
	const h = createHash("sha256");
	for (const f of files) {
		h.update(`${f}\n`);
		try {
			h.update(readFileSync(path.join(root, f)));
		} catch {
			/* deleted since listing */
		}
	}
	return { hash: h.digest("hex").slice(0, 16), count: files.length };
}
