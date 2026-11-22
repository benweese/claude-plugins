// node:test for qa-components: runner detection (never picks one), the Playwright skill's path, story coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coverage, coverageLines, detect, detectLines, skillPath } from "../bin/qa-components";

const SAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples", "sample-app");

function repo(devDependencies = {}, files = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "qa-components-"));
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies }));
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		writeFileSync(path.join(dir, rel), text);
	}
	return dir;
}
const ids = (r) => r.runners.map((x) => x.id);

test("no runner → don't pick: list the options and ask", () => {
	const r = detect(repo({ react: "^19.0.0" }));
	assert.deepEqual(ids(r), []);
	assert.match(detectLines(r)[0], /No component-test runner found\. Don't pick one: .* ask the user/);
});

test("Playwright ≥ 1.62 with a gallery or mount() specs is a runner; without either it's only a note", () => {
	assert.deepEqual(ids(detect(repo({ "@playwright/test": "^1.65.0" }, { "playwright/gallery/index.html": "<div id=root></div>" }))), ["playwright-gallery"]);
	assert.deepEqual(ids(detect(repo({ "@playwright/test": "^1.65.0" }, { "tests/components/b.spec.ts": 'await mount("Button/Primary")' }))), ["playwright-gallery"]);
	const bare = detect(repo({ "@playwright/test": "^1.65.0" }, { "tests/e2e/home.spec.ts": 'await page.goto("/")' }));
	assert.deepEqual(ids(bare), []);
	assert.match(bare.notes[0], /built-in mount fixture, but there's no story gallery/);
	assert.deepEqual(ids(detect(repo({ "@playwright/test": "^1.60.0" }, { "playwright/gallery/index.html": "" }))), [], "mount arrived in 1.62");
});

test("the old experimental packages are detected with a migration warning", () => {
	const r = detect(repo({ "@playwright/test": "1.62.1", "@playwright/experimental-ct-react": "1.62.1" }));
	assert.deepEqual(ids(r), ["playwright-ct-experimental"]);
	assert.match(detectLines(r).join("\n"), /removed in Playwright 1\.63 .* migration guide/);
});

test("Storybook, Vitest browser / jsdom and Jest are detected; jsdom ones warn about what can't run", () => {
	assert.deepEqual(ids(detect(repo({ "@storybook/test-runner": "^0.26.0" }))), ["storybook-test-runner"]);
	assert.deepEqual(ids(detect(repo({ "@storybook/addon-vitest": "^10.0.0", vitest: "^5.0.0", "@vitest/browser-playwright": "^5.0.0" }))), ["storybook-vitest", "vitest-browser"]);
	const dom = detect(repo({ vitest: "^5.0.0", jsdom: "^27.0.0", "@testing-library/react": "^16.0.0" }));
	assert.deepEqual(ids(dom), ["vitest-dom"]);
	assert.match(dom.runners[0].name, /Testing Library/);
	assert.match(dom.runners[0].warning, /contrast, focus visibility and reflow checks can't run/);
	assert.deepEqual(ids(detect(repo({ jest: "^30.0.0", "@testing-library/react": "^16.0.0" }))), ["jest-dom"]);
});

test("more than one runner → follow the existing tests, else ask", () => {
	const r = detect(repo({ "@storybook/test-runner": "^0.26.0", vitest: "^5.0.0", "@vitest/browser": "^5.0.0" }));
	assert.match(detectLines(r)[0], /More than one runner: .* if that's unclear, ask the user/);
});

test("the Playwright skill is read from the repo's own node_modules (version-matched), never bundled or linked", () => {
	const skill = "lib/tools/skills/playwright-component-testing/SKILL.md";
	const top = repo({ "@playwright/test": "1.65.1" }, { [`node_modules/playwright-core/${skill}`]: "# skill", "node_modules/@playwright/test/package.json": '{"version":"1.65.1"}' });
	assert.equal(skillPath(top), `node_modules/playwright-core/${skill}`);
	assert.match(detectLines(detect(top)).at(-1), /matches the installed Playwright 1\.65\.1\): node_modules\/playwright-core\/lib\/tools\/skills/);
	const nested = repo({}, { [`node_modules/@playwright/test/node_modules/playwright-core/${skill}`]: "# skill" });
	assert.equal(skillPath(nested), `node_modules/@playwright/test/node_modules/playwright-core/${skill}`);
	const none = detect(repo({}));
	assert.equal(none.skill, null);
	assert.match(detectLines(none).at(-1), /isn't in node_modules/);
});

test("sample fixture: the LoadFailed story is untested; every other state is mounted", () => {
	const dir = repo({ "@playwright/test": "^1.65.0" });
	cpSync(path.join(SAMPLE, "src"), path.join(dir, "src"), { recursive: true });
	cpSync(path.join(SAMPLE, "fixtures", "components", "tests"), path.join(dir, "tests"), { recursive: true });
	const c = coverage(dir);
	assert.deepEqual(c.stories.map((s) => s.id).sort(), ["components/BookList/Default", "components/BookList/Disabled", "components/BookList/Empty", "components/BookList/LoadFailed", "components/BookList/Loading"]);
	assert.deepEqual(c.untested.map((s) => s.id), ["components/BookList/LoadFailed"]);
	assert.deepEqual(c.unknown, []);
	assert.deepEqual(c.components[0].noStoryFor, [], "all five common states have a story");
	assert.match(coverageLines(c).join("\n"), /UNTESTED stories \(no test mounts them\): components\/BookList\/LoadFailed/);
});

test("coverage: suffix ids, unknown mounts, missing-state hints, .vue and default exports, qa.json folders", () => {
	const dir = repo({}, {
		"ui/widgets/Toggle.story.tsx": "export const Off = () => null;\nexport const On = () => null;\n",
		"ui/widgets/Badge.story.vue": "<template><span /></template>",
		"ui/Card.story.js": "export default () => null;\n",
		"e2e/components/t.spec.ts": 'await mount("Toggle/Off");\nawait mount<typeof X>("widgets/Badge");\nawait mount("Toggle/Missing");\n',
		".claude/qa.json": JSON.stringify({ version: 1, components: { storiesRoot: "ui", testDir: "e2e" } })
	});
	const c = coverage(dir);
	const by = Object.fromEntries(c.stories.map((s) => [s.id, s.testedBy.length]));
	assert.deepEqual(by, { "widgets/Toggle/Off": 1, "widgets/Toggle/On": 0, "widgets/Badge": 1, Card: 0 });
	assert.deepEqual(c.unknown.map((u) => u.id), ["Toggle/Missing"]);
	const toggle = c.components.find((k) => k.component === "widgets/Toggle");
	assert.deepEqual(toggle.noStoryFor, ["default", "empty", "loading", "error", "disabled"]);
	assert.match(coverageLines(c).join("\n"), /widgets\/Toggle: no story named for default, empty, loading, error, disabled/);
	assert.match(coverageLines(coverage(repo({}))).join("\n"), /No \*\.story\.\* files found/);
});
