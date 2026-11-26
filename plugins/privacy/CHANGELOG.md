# Changelog

All notable changes to the `privacy` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.1.4] - 2026-11-25

### Fixed

- **The commit blocker missed commits made through git aliases.** `git ci -m x` with `alias.ci = commit` (repo, global or system config, or an inline `git -c alias.ci=commit`) is now checked as a commit, with the alias's arguments counted. Aliases are expanded the way git does: an alias named like a real command is ignored, chains are followed, and `-C` inside an alias moves the repo. A shell alias that runs `git … commit`, an alias loop, or a lookup that times out asks: "can't parse this commit; personal data not checked". An alias in a repo that can't be determined asks too. The shared parsing (`shared/commit-content.mjs`) is the same as in guardrails 0.1.5.
- **Aliases inside strings, and xargs.** `bash -c '…'` and `eval '…'` strings are parsed as command lines of their own, up to 3 levels deep, so aliases and commits inside them are scanned. Deeper nesting with `git` in it asks. `xargs` running a commit asks with "can't see xargs arguments; personal data not checked". The command's own `GIT_CONFIG_*` / `HOME` prefixes, and earlier `export` / `unset` of them, count for alias lookups, and a value from `$…` asks. Any shell alias that runs `git` asks.

## [0.1.3] - 2026-11-25

### Fixed

- **The entry-point check no longer goes silent when `realpath` fails.** `isMain()` (`scripts/is-main.mjs`, a synced copy of `shared/is-main.mjs`) used to return false if resolving a path threw (for example a permission error on a folder in the path), so the commit hook, `/privacy-scan` and installer did nothing. Now it falls back to comparing the plain resolved paths, the check used before the symlink fix. The worst case is the old behaviour (no symlink support), never a silent no-op.

## [0.1.2] - 2026-11-25

### Fixed

- **The commit blocker scanned the wrong repo, or nothing, for many common commit commands.** It now scans each commit in the repo it runs in, following `cd`, `pushd`, `env -C` / `--chdir`, `sudo -D` and `git -C`. It also unwraps `env`, `command`, `sudo` (options and combined flags), `nohup`, `time`, `timeout`, `nice`, `ionice`, `stdbuf`, `chrt`, `taskset`, `setsid`, `exec`, `!` and shell keywords, `\git` and `/usr/bin/git`. Anything else that mentions `git commit` and can't be parsed (`xargs git commit`, `bash -c '… git commit …'`) asks: "can't parse this commit; personal data not checked". `( … )` subshells restore the directory at `)`; `{ … }` groups keep a `cd`. Every commit in a command is checked, and the session project's config and denylist apply to all of them.
- **When the repo can't be determined, it asks instead of passing.** Examples: `cd "$(…)"`, `cd "$DIR"`, `cd -`, `pushd +N`, `popd`, a missing folder, `GIT_DIR=…`, or a `cd` inside `( … )`. The prompt says "can't tell which repo this commits in; personal data not checked". An `env -S` string that mentions `git` asks with "can't parse env -S; personal data not checked". It never falls back to scanning the starting folder.
- The shared command parsing (`shared/commit-content.mjs`, synced into `scripts/commit-content.mjs`) replaces `commitPlan()` with the directory-aware `commitPlans()`. It is shared with guardrails 0.1.3.

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
