# Changelog

All notable changes to the `privacy` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.1.0] - 2026-11-21

### Added

- **Detectors:** email addresses (example / test / noreply domains skipped), card numbers that pass the Luhn check, SSN-like numbers (never-issued prefixes skipped), US phone numbers (555-01xx skipped); opt-in dollar amounts, custom regexes and a denylist (names and words match whole words; numbers need digit boundaries). An allowlist of strings or `/regex/`. Matched values are never printed.
- **Commit blocker** (opt-in, `.claude/privacy.json` `"commitHook": true`): before Claude runs `git commit`, scans what will be committed — the index, tracked changes for `-a` / `--all`, and paths a chained `git add` stages — and blocks on a match.
- **Denylist** from a local file or a URL (`https://…` or `gh:owner/repo/path` through your `gh` login). URLs are only downloaded by `/privacy-scan refresh` into a gitignored cache; hooks never fetch. A missing or 7+ day old cache, or a denylist that isn't gitignored, is reported.
- **`/privacy-scan [staged | refresh | path …]`** and the **`privacy-reviewer`** agent (finds what patterns miss; report only).
- **`install-privacy-git-hook`**: installs a self-contained scanner as git's pre-commit hook for commits made outside Claude. Respects `core.hooksPath`, stops for husky with instructions, never overwrites an existing hook without `--force`, and only reports success after checking git will run it. No denylist values are written into the hook.
