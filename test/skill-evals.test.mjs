// Skill Eval cases: every own skill (not Playwright's vendored playwright-cli) has 3–5 cases in evals/, each with
// name, prompt and criteria, and at least one negative (expect_skill: false). Plus scripts/eval-skills.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedSkills, evalSkills, oneSkill } from "../scripts/eval-skills.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every own skill has 3–5 eval cases with name, prompt, criteria and a negative case", () => {
	const plugins = path.join(ROOT, "plugins");
	const skills = readdirSync(plugins).flatMap((p) => {
		try {
			return readdirSync(path.join(plugins, p, "skills")).map((s) => `${p}/${s}`);
		} catch {
			return [];
		}
	}).filter((s) => s !== "qa/playwright-cli");
	assert.deepEqual(evalSkills(ROOT).map((s) => `${s.plugin}/${s.skill}`).sort(), skills.sort(), "every own skill has evals/");
	for (const s of evalSkills(ROOT)) {
		const dir = path.join(ROOT, s.path, "evals");
		const cases = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
		assert.ok(cases.length >= 3 && cases.length <= 5, `${s.path}: ${cases.length} cases (want 3–5)`);
		let negative = 0;
		for (const f of cases) {
			const text = readFileSync(path.join(dir, f), "utf8");
			for (const key of ["name", "prompt", "criteria"]) assert.match(text, new RegExp(`^${key}:`, "m"), `${s.path}/evals/${f}: ${key}`);
			assert.match(text, /^criteria:\n {2}- /m, `${s.path}/evals/${f}: at least one criterion`);
			if (/^expect_skill: false$/m.test(text)) negative++;
		}
		assert.ok(negative >= 1, `${s.path}: needs a negative case (expect_skill: false)`);
	}
});

test("eval-skills: changed skills with evals only, never playwright-cli; one named skill, validated", () => {
	const got = changedSkills(ROOT, ["plugins/qa/skills/review-tests/SKILL.md", "plugins/qa/skills/playwright-cli/SKILL.md", "plugins/qa/agents/x.md", "plugins/workflow/skills/board/evals/001.yaml", "README.md"]);
	assert.deepEqual(got.map((s) => `${s.plugin}/${s.skill}`), ["qa/review-tests", "workflow/board"]);
	assert.deepEqual(oneSkill(ROOT, "qa/review-tests"), [{ plugin: "qa", skill: "review-tests", path: "plugins/qa/skills/review-tests" }]);
	assert.throws(() => oneSkill(ROOT, "qa/playwright-cli"), /no such skill with evals/);
	assert.throws(() => oneSkill(ROOT, "qa/nope"), /no such skill with evals/);
	assert.throws(() => oneSkill(ROOT, "qa/x; rm -rf /"), /isn't <plugin>\/<skill>/);
	assert.deepEqual(changedSkills(ROOT, ["README.md"]), []);
});
