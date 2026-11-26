# benweese/claude-plugins

A public Claude Code plugin marketplace: qa, docs, workflow, guardrails, privacy, accessibility. Each plugin lives in
`plugins/<name>/`; `.claude-plugin/marketplace.json` lists them.

## Read first

- `docs/marketplace-plan.md` before changing a hook, a config file or a plugin's scope: it is the source of truth for
  the hook rules and the `.claude/<plugin>.json` formats.
- `README.md` "Releasing a plugin" before tagging; `docs/review-rules.md` before changing a review prompt.
- code.claude.com/docs for any Claude Code behaviour you rely on: verify it there and cite the page in the PR.

## Rules that bite

- **Opt-in hooks:** a hook acts only when `.claude/<plugin>.json` has `"version": 1` and opts in; missing or invalid
  means off. The one exception is the guardrails secret blocker, on by default.
- **Hook code:** Node, no network, no dependencies. A block carries its reason (exit 2 + stderr, or a JSON deny).
- **Hook tests:** every hook has `node:test` tests in `plugins/<name>/test/`; run the full suite before pushing.
- **Version bump:** `plugin.json`, `marketplace.json`, the root README table, the plan's table row and the plugin
  CHANGELOG change together, in the same commit.
- **`shared/`** is the source; `node scripts/sync-shared.mjs` copies it into the plugins. Edit `shared/`, then sync.
- **Public repo:** made-up data only (example.com, fictional names); never cite issue numbers from private repos.
- **Hooks don't run in CI;** the workflows are the backstop: `validate.yml` (strict validate + all tests), actionlint,
  gitleaks, CodeQL, skill evals and the Claude review.
- **Playwright specs the qa plugin writes use `expect.soft`;** its healer never changes an expect, it asks.

## Who does what

- Unit tests → mattpocock-skills `tdd`. E2E / Playwright → this repo's qa plugin. The qa plugin is never edited to
  fit outside skills (Matt's or titstack).
- Review → Matt's `/mattpocock-skills:code-review` locally before pushing; the CI review (`claude-review.yml`) wins
  on conflicts.
- PR body → `Closes #n` / `## Summary` (one visual + 1–3 lines, optional `**Assumptions:**` line) / `## Evidence`
  (failing-before test, then a click-by-click manual test with ✅) / `## Merge danger` (Door, Blast radius).

## Commands

- All tests: `node --test plugins/*/test/*.test.mjs test/*.test.mjs examples/sample-app/server.test.mjs`
- One skill's evals: `node scripts/eval-skills.mjs one <plugin>/<skill>`
- Validate a plugin: `claude plugin validate plugins/<name> --strict`

## Work and releases

- Issues live in this repo, on the GitHub Project (Phase "Plugins"); start one with `/board`. Branch
  `{number}-{slug}`; main changes only through a PR, and Ben merges.
- Releases: after the bump merges, the maintainer pushes a signed `<plugin>--v<version>` tag
  (`claude plugin tag --push`); `release.yml` runs `scripts/release.mjs`, which checks the tag and publishes the
  GitHub release from that CHANGELOG section. CI never creates tags.
