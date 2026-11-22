# Changelog

Changes to the **`benweese` marketplace** itself: plugins added or removed, CI and repo plumbing. The marketplace has no version of its own, so entries are by date. Each plugin keeps its own changelog for what changed inside it:

| Plugin | Changelog |
| ------ | --------- |
| qa | [plugins/qa/CHANGELOG.md](plugins/qa/CHANGELOG.md) |
| docs | [plugins/docs/CHANGELOG.md](plugins/docs/CHANGELOG.md) |
| workflow | [plugins/workflow/CHANGELOG.md](plugins/workflow/CHANGELOG.md) |
| guardrails | [plugins/guardrails/CHANGELOG.md](plugins/guardrails/CHANGELOG.md) |
| privacy | [plugins/privacy/CHANGELOG.md](plugins/privacy/CHANGELOG.md) |
| accessibility | [plugins/accessibility/CHANGELOG.md](plugins/accessibility/CHANGELOG.md) |

## 2026-11-22

### Added

- CI: **gitleaks** secret scanning on every push and PR, **actionlint** when workflows change, and **CodeQL** (JavaScript/TypeScript and the workflows) on PRs, pushes to `main` and weekly.
- This changelog.
- Docs site: a page for every plugin's README, CHANGELOG and `docs/`, built from `marketplace.json` (a new plugin gets pages automatically), with a second navigation row on each plugin's pages. Old `changelog.html` and `worked-example.html` redirect to their new names.

### Changed

- Every action in every workflow is pinned to a commit SHA (Dependabot keeps them current); a test fails on any unpinned `uses:`.

### Fixed

- gitleaks and actionlint didn't start: the repo allows only GitHub-owned actions. Both now run their official images with `docker run`, pinned by tag + digest in `.github/docker/<tool>/Dockerfile`; Dependabot's docker ecosystem keeps those current. Tests check that workflows match the Actions policy.
- The root README's plugin table is checked against each `plugin.json` version in CI.

## 2026-11-21

### Added

- **privacy** 0.1.0 and **accessibility** 0.1.0 plugins.
- `shared/`: code more than one plugin uses (`commit-content.mjs`), copied into each plugin by `scripts/sync-shared.mjs`; a test fails if a copy drifts.
- `examples/sample-app/` grew fixtures for the qa plugin's review-tests, a11y testing and component testing, and a real Playwright run in CI (`A11Y_NODE_MODULES`).

## 2026-11-20

### Added

- **Restructured into the `benweese` marketplace:** `plugins/<name>/`, each installed on its own as `<name>@benweese`. The Playwright plugin became **qa** 1.0.0 (it was `playwright-qa-agents` 0.10.0); new **docs** and **workflow** 0.1.0, then **guardrails** 0.1.0.
- `examples/sample-app/`: a tiny dependency-free app the plugins test themselves against.
- CI validates the marketplace and every plugin (`claude plugin validate --strict`) and runs every plugin's `node:test` suite.

## 2026-11-12

### Added

- Docs site at code.benweese.com/playwright-ai-qa-agents/, rendered with GitHub's Markdown API.
- CI fails when a plugin's `plugin.json` and `marketplace.json` versions differ.

## 2026-11-08

### Added

- First release: the `playwright-qa-agents` Claude Code plugin.
