# Changelog

All notable changes to the `guardrails` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.1.3] - 2026-11-25

### Fixed

- **The secret blocker scanned the wrong repo, or nothing, for many common commit commands.** It now scans each commit in the repo it runs in, following `cd`, `pushd`, `env -C` / `--chdir`, `sudo -D` and `git -C`. It also unwraps `env`, `command`, `sudo` (options and combined flags like `-nu root`, read the way getopt reads them), `nohup`, `time`, `timeout`, `nice`, `ionice`, `stdbuf`, `chrt`, `taskset`, `setsid`, `exec`, `!` and shell keywords (`if … then`, `while … do`), `\git` and `/usr/bin/git`, nested in any order. Anything else that mentions `git commit` as plain words (`xargs git commit`, `eval git commit`), or a `bash`/`sh`/`zsh`/`dash`/`ksh -c` string that does, asks: "can't parse this commit; secrets not checked". A quoted mention such as `echo "git commit"` doesn't. `( … )` subshells restore the directory at `)`; `{ … }` groups keep a `cd`. Every commit in a command is checked, not only the first.
- **When the repo can't be determined, it asks instead of passing.** Examples: `cd "$(…)"`, `cd "$DIR"`, `cd -`, `pushd +N`, `popd`, a missing folder, `GIT_DIR=…`, `git --git-dir`, or a `cd` inside `( … )`. The prompt says "can't tell which repo this commits in; secrets not checked". An `env -S` string that mentions `git` asks with "can't parse env -S; secrets not checked". It never falls back to scanning the starting folder.
- **Dangerous commands (opt-in):** `sudo -u someone rm -rf /` and other wrapped `rm` commands are caught. When the folder can't be determined, a relative `rm` target isn't guessed at.
- **gitleaks findings show the real line number.** The temp file holds only the added lines, so its line numbers were wrong before; they're now mapped back. Staged and unstaged changes to the same file are no longer run together in one temp file.

## [0.1.2] - 2026-11-25

### Fixed

- **The hooks did nothing when run through a symlinked path** (a symlinked script or plugin folder): the "am I the script being run?" check compared `process.argv[1]`, which keeps the symlink, with the resolved `import.meta.url`, so it never matched and the hook exited 0 without checking anything. That includes the secret blocker, which is on by default. All three hooks now use `isMain()` from `scripts/is-main.mjs` (a synced copy of `shared/is-main.mjs`), which compares real paths.
- Hooks set `process.exitCode` instead of calling `process.exit()`, so their output can finish writing on a pipe. Exit codes and decisions are unchanged: the secret blocker and protected files deny with exit 0 + a `permissionDecision: "deny"` JSON; lint after edit reports failures with exit 2.
- Tests: each hook blocks the same way run directly, through a symlinked script and through a symlinked folder; a source check fails if any entry point uses `process.exit()`, compares `process.argv[1]` directly, or has code after `finish()`.

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
