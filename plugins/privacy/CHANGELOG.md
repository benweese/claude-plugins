# Changelog

All notable changes to the `privacy` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.1.1] - 2026-11-25

### Fixed

- **The commit hook, `/privacy-scan` and `install-privacy-git-hook` did nothing when run through a symlinked path** (a symlinked file or plugin folder): the "am I the script being run?" check compared `process.argv[1]`, which keeps the symlink, with the resolved `import.meta.url`. They now use `isMain()` from `scripts/is-main.mjs` (a synced copy of `shared/is-main.mjs`), which compares real paths.
- They, and the plain-git scanner (`git-pre-commit.mjs`), set `process.exitCode` and return instead of calling `process.exit()`, so output can finish writing. Behaviour is unchanged: the commit hook denies with exit 0 + a `permissionDecision: "deny"` JSON; the plain-git scanner blocks with exit 1; `/privacy-scan` exits 0 / 1 / 2. Re-run `install-privacy-git-hook` to pick up the new scanner copy (as after any update).
- `bin/package.json` (`{"type": "module"}`): the installer loads as an ES module without relying on Node's module syntax detection.
- Tests: each entry point gives the same result directly, through a symlinked file and through a symlinked folder; a refresh failure prints one line and exits 2; a source check fails on `process.exit()` or a direct `process.argv[1]` comparison.

## [0.1.0] - 2026-11-21

### Added

- **Detectors:** email addresses (example / test / noreply domains skipped), card numbers that pass the Luhn check, SSN-like numbers (never-issued prefixes skipped), US phone numbers (555-01xx skipped); opt-in dollar amounts, custom regexes and a denylist (names and words match whole words; numbers need digit boundaries). An allowlist of strings or `/regex/`. Matched values are never printed.
- **Commit blocker** (opt-in, `.claude/privacy.json` `"commitHook": true`): before Claude runs `git commit`, scans what will be committed — the index, tracked changes for `-a` / `--all`, and paths a chained `git add` stages — and blocks on a match.
- **Denylist** from a local file or a URL (`https://…` or `gh:owner/repo/path` through your `gh` login). URLs are only downloaded by `/privacy-scan refresh` into a gitignored cache; hooks never fetch. A missing or 7+ day old cache, or a denylist that isn't gitignored, is reported.
- **`/privacy-scan [staged | refresh | path …]`** and the **`privacy-reviewer`** agent (finds what patterns miss; report only).
- **`install-privacy-git-hook`**: installs a self-contained scanner as git's pre-commit hook for commits made outside Claude. Respects `core.hooksPath`, stops for husky with instructions, never overwrites an existing hook without `--force`, and only reports success after checking git will run it. No denylist values are written into the hook.
