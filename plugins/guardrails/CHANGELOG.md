# Changelog

All notable changes to the `guardrails` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.1.1] - 2026-11-21

### Changed

- The "what will this commit contain" logic now comes from one shared source (`shared/commit-content.mjs`, copied into `scripts/commit-content.mjs`), so guardrails and privacy check exactly the same content. No behaviour change.

## [0.1.0] - 2026-11-21

### Added

- **Secret blocker** (on by default): before Claude runs `git commit`, scans what will be committed — the staged changes, tracked changes for `-a` / `--all`, and paths a chained `git add …` stages — with gitleaks if installed, else built-in patterns. A match blocks the commit, secrets masked.
- **Protected files** (opt-in): blocks Claude from reading or changing `.env*`, `*.pem`, `*.key`, `id_*`, `credentials*`; `.env.example` / `.env.sample` / `.env.template` allowed; both lists configurable.
- **Dangerous commands** (opt-in): asks first for force-push to the repo's default branch (detected from git), `git reset --hard`, `git clean -fd` / `-fdx`, `git checkout -- .`, `git restore .`, and `rm -rf` on `/`, `~`, `$HOME` or the repo root.
- **Lint after edit** (opt-in): your `lintCommand`, or the project's ESLint for JS/TS; failures go back to Claude; skips test files the `qa` plugin's hook already lints.
- `.claude/guardrails.json` (`"version": 1`) and `BENWEESE_GUARDRAILS_OFF`.
