# Changelog

All notable changes to the `docs` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.2.0] - 2026-11-21

### Added

- **`/docs`**, one skill with two modes:
  - `/docs sweep [path]`: what `update-docs` did — a README that matches the code, split `CLAUDE.md` files, JSDoc/TSDoc, only "why" comments, with proof that no behaviour changed.
  - `/docs phase <N>`: the end-of-phase docs update — the phase's closed issues and merged PRs, plan status, changelog entry, `CLAUDE.md` line budgets, README and runbook, project-specific steps, a privacy check, and the "docs: Phase N docs update" PR that closes the docs issue.
- `.claude/docs.json` (`"version": 1`, every field optional; missing or invalid = defaults): `plan`, `changelog`, `runbook`, `milestone`, `docsIssue`, `prTitle`, `claudeMdLines`, `extraSteps`.

### Deprecated

- `update-docs`: renamed to `/docs sweep`. `/docs:update-docs` still works for this version (it says so, then runs the sweep) and is removed in 0.3.0.

## [0.1.0] - 2026-11-20

### Added

- `update-docs`, moved unchanged from the `playwright-qa-agents` plugin (0.10.0). It is now `/docs:update-docs`.
