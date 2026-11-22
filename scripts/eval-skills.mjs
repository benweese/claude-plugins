// Which skills the Skill Eval workflow runs: [{plugin, skill, path}] as JSON on stdout (and to $GITHUB_OUTPUT as
// skills=…). Only skills with an evals/ folder; never qa/playwright-cli (Playwright's vendored skill).
//   node scripts/eval-skills.mjs changed <base-ref>   skills whose files changed vs <base-ref> (an "eval"-labelled PR)
//   node scripts/eval-skills.mjs one <plugin>/<skill>  one named skill (workflow_dispatch)
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKIP = new Set(["qa/playwright-cli"]);

/** Every skill that has evals: [{plugin, skill, path}]. */
export function evalSkills(root) {
	const out = [];
	const plugins = path.join(root, "plugins");
	for (const plugin of readdirSync(plugins).sort()) {
		const skills = path.join(plugins, plugin, "skills");
		if (!existsSync(skills)) continue;
		for (const skill of readdirSync(skills).sort()) {
			if (SKIP.has(`${plugin}/${skill}`) || !existsSync(path.join(skills, skill, "evals"))) continue;
			out.push({ plugin, skill, path: `plugins/${plugin}/skills/${skill}` });
		}
	}
	return out;
}

/** The skills touched by a list of changed paths. */
export function changedSkills(root, files) {
	const touched = new Set(files.map((f) => /^plugins\/([^/]+)\/skills\/([^/]+)\//.exec(f)).filter(Boolean).map((m) => `${m[1]}/${m[2]}`));
	return evalSkills(root).filter((s) => touched.has(`${s.plugin}/${s.skill}`));
}

/** One skill by "<plugin>/<skill>"; throws if it doesn't exist, has no evals or is skipped. */
export function oneSkill(root, name) {
	if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(String(name))) throw new Error(`"${name}" isn't <plugin>/<skill> (e.g. qa/review-tests)`);
	const hit = evalSkills(root).find((s) => `${s.plugin}/${s.skill}` === name);
	if (!hit) throw new Error(`${name}: no such skill with evals (choose from: ${evalSkills(root).map((s) => `${s.plugin}/${s.skill}`).join(", ")})`);
	return [hit];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [mode, arg] = process.argv.slice(2);
	try {
		let list;
		if (mode === "changed") {
			const r = spawnSync("git", ["diff", "--name-only", `${arg}...HEAD`], { encoding: "utf8" });
			if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
			list = changedSkills(process.cwd(), r.stdout.split("\n").filter(Boolean));
		} else if (mode === "one") list = oneSkill(process.cwd(), arg);
		else throw new Error("usage: eval-skills.mjs changed <base-ref> | one <plugin>/<skill>");
		const json = JSON.stringify(list);
		console.log(json);
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skills=${json}\n`);
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
}
