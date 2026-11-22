# Changelog

All notable changes to the `qa` plugin (named `playwright-qa-agents` before 1.0.0). Versions follow [semantic versioning](https://semver.org/).

## [1.2.0] - 2026-11-21

### Added

- **Works without playwright-test-commons.** When commons isn't installed, the generators copy its helpers into the repo with `qa-support` (on Claude's PATH): `core` and `ui` bundles copied only as needed, into `tests/support/` (or `.claude/qa.json` `"supportDir"`), TypeScript sources or compiled JS + `.d.ts` for repos without a tsconfig. Tests import the copy with relative paths. With commons installed, nothing changes.
- `qa-support status | plan | install | update`: shows the devDependencies the helpers need (never edits `package.json`; skips compatible installs; never downgrades), stamps each copy with the commons version and its hash, offers updates for unmodified older copies, leaves edited ones alone, and stops on files it didn't write.
- Helper templates generated from playwright-test-commons **v0.8.0** (`scripts/sync-commons-templates.mjs`); a test fails if a template changes, and CI fails if they drift from the tag.

### Changed

- playwright-test-commons is optional (recommended). Its `check-test-ids` stays there: for an id check in CI, install commons and run it.

## [1.1.0] - 2026-11-21

### Added

- **Test-file hook** (`PostToolUse` on Edit / Write / MultiEdit): after a `*.{spec,test}.{ts,js,mjs,cjs}` file is edited, it lints that file with the project's ESLint and checks `playwright test --list <file>` still loads it, from the nearest `playwright.config.*` folder. Failures go back to Claude to fix (the edit stays); a missing tool or the 60 s cap is reported as skipped, never a silent pass; every result shows the elapsed time. **Opt-in per project** (`.claude/qa.json`); off everywhere else. No network.

## [1.0.0] - 2026-11-20

### Changed (breaking)

- **Renamed `playwright-qa-agents` → `qa`**, and the marketplace `playwright-ai-qa-agents` → `benweese`. Install with `claude plugin install qa --marketplace benweese/playwright-ai-qa-agents` (or `claude plugin marketplace add benweese/playwright-ai-qa-agents` then `claude plugin install qa@benweese`). Uninstall the old `playwright-qa-agents@playwright-ai-qa-agents` first.
- Skills are now `/qa:<skill>` (was `/playwright-qa-agents:<skill>`).
- **Moved out:** `check` → the `workflow` plugin (`/workflow:check`); `update-docs` → the `docs` plugin (`/docs:update-docs`).
- The plugin now lives in `plugins/qa/` of a multi-plugin marketplace repo.

No change to what the agents and remaining skills do.

## [0.10.0] - 2026-11-12

### Changed

- **ui-test-healer** runs every `playwright-cli` command in its own named session (`-s=heal-<name>`), deletes any data it creates and reports what it couldn't, and keeps the repo's worker count.
- **ui-test-generator** confirms the plan was approved before generating. Both generators now stop and ask when they can't tell.
- **Both generators** follow Playwright's isolated-test practice: tests pass alone and in any order, a dependent journey is one test with a `test.step` per stage, and shared data is created per worker. Serial mode stays banned.
- **page-mapper** states that the test repo's `CLAUDE.md` wins over its defaults, like the other agents.

### Added

- `docs/worked-example.md`: the cart feature of playwright-e2e-demo, from page map to the healer's final diff, with token use per stage. It links the reviewed cart plan, `plans/ui-cart.md`, pinned to the e2e commit that added it.
- README: how to check the plugin loaded (Claude Code no longer has `/agents`), the VS Code reload command, "What review caught", "Limitations" (convention vs enforced guardrails, measured cost, when not to use it) and "Background", which links the published blog post.
- README "Convention or enforced": serial mode and skipped or conditional tests are now lint errors in playwright-e2e-demo.
- README "What review caught": the orphaned test account was deleted afterwards with `deleteAccount`.
- CI fails when `plugin.json` and `marketplace.json` have different versions.

### Fixed

- README described the healer as leaving plan-vs-page mismatches failing. It marks them `test.fixme()` with the expected and actual result.

## [0.9.0] - 2026-11-12

Fixes from building the [playwright-e2e-demo](https://github.com/benweese/playwright-e2e-demo) suite.

- page-mapper: named sessions, shared-site etiquette and cleanup, login and resume steps, repo locator rules, observed vs expected behaviour, template sections for input behaviour, success states and flows.
- api-test-planner: a Schemas section; undocumented negative cases go to open questions.
- ui-test-planner: the requirement wins over the page, with an "Expected findings" table; `@smoke` checked against project tags; every element checked for a locator; id ranges for parallel planners; no locator code in plans.
- api-test-generator: never serial, `UPDATE_SCHEMAS=true` for new schemas, the repo's status helper, unconditional cleanup, read helpers before relying on them.
- ui-test-generator: repo locator rules, named sessions, delete what exploration creates, don't raise workers, commons `BasePage` checks.
- README: terminal install, a new session after installing, `claude plugin update`, playwright-test-commons v0.7.0.

## [0.8.1] - 2026-11-10

- Planners: whether plans are committed is up to the test repo.

## [0.8.0] - 2026-11-10

- Agents read the test repo's per-folder `CLAUDE.md` guides; `update-docs` keeps `CLAUDE.md` split into a root file and folder guides.

## [0.7.1] - 2026-11-10

- update-docs removes comments that only made sense to their author.

## [0.7.0] - 2026-11-10

- Added the `update-docs` skill: detailed READMEs, JSDoc everywhere, only comments that explain why.

## [0.6.1] - 2026-11-10

- Generators document reusable code with JSDoc.

## [0.6.0] - 2026-11-10

- Response bodies are typed in the API clients; no environment settings.

## [0.5.0] - 2026-11-10

- Bundled Playwright's `playwright-cli` skill in the plugin.

## [0.4.1] - 2026-11-10

- Agents use the test repo's `playwright-cli` skill; removed the frontmatter check script from CI.

## [0.4.0] - 2026-11-10

- Agents write TypeScript: `.ts` files, typed bodies, and lint that includes the type-check.

## [0.3.0] - 2026-11-10

- Numeric test ids, unique across the repo (`#0012`); the kind of test comes from tags.

## [0.2.1] - 2026-11-10

- Run tests with `npx playwright test` instead of `npm test`.

## [0.2.0] - 2026-11-10

- Dropped briefs; plans open with acceptance criteria.

## [0.1.1] - 2026-11-10

- Locators scope to a good container instead of requiring `data-*` anchors.

## [0.1.0] - 2026-11-08

- First release: page-mapper, API and UI planners and generators, the UI healer, and the `author-tests`, `run-spec`, `check` and `bug-report` skills.

[0.10.0]: https://github.com/benweese/playwright-ai-qa-agents/releases/tag/v0.10.0
