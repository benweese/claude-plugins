# Changelog

All notable changes to the `guardrails` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.1.6] - 2026-11-25

### Fixed

- **A hung scan let the commit through.** If the secret scan ran past the hook's 60 s timeout (a stuck `git` or `gitleaks`, a slow network drive), Claude Code ran the commit unchecked. The scan now has its own 40 s budget per command, and each `git diff` / `git ls-files` / `gitleaks` call is capped by the time left and killed when it runs out. A scan that runs out of time asks: "secret scan timed out; secrets not checked". If only gitleaks runs out of time, the built-in patterns check the commit instead ("checked with built-in patterns (gitleaks timed out)"); 5 s of the budget is kept back for that.
- **The `pre-bash` hook sets `"onFailure": "block"`**, so on Claude Code v2.1.295 or later a hook that times out, crashes or can't start blocks the Bash command instead of letting it through. Older versions ignore the field: `claude plugin validate` on 2.1.200, 2.1.250 and 2.1.294 accepts it without a warning, and the 2.1.294 hook schema drops unknown keys (a live session on an older version wasn't run). There the scan's own budget is what asks.

## [0.1.5] - 2026-11-25

### Fixed

- **The secret blocker missed commits made through git aliases.** `git ci -m x` with `alias.ci = commit` (in the repo, global or system config, or an inline `git -c alias.ci=commit`) is now checked as a commit, with the alias's arguments counted (`alias.ci = commit -a` scans unstaged changes). Aliases are expanded the way git does: an alias named like a real command is ignored, chains are followed up to 5 levels, and `-C` inside an alias moves the repo. A shell alias (`!…`) that runs `git … commit`, an alias loop, `--config-env alias.*`, or a lookup that times out (2 s per git call, ~5 s per run) asks: "can't parse this commit; secrets not checked". An alias in a repo that can't be determined asks too. `git --list-cmds` runs only when a subcommand isn't `commit` or `add`, once per run.
- **Aliases inside strings, and xargs.** `bash -c '…'` (also `sh`, `zsh`, `dash`, `ksh`) and `eval '…'` strings are parsed as command lines of their own, with the same directory and the same alias budget, up to 3 levels deep. So `bash -c "git ci -m x"` and `eval "git ci -m x"` are scanned, and `sh -c 'git commit -m x'` is scanned instead of only asking. Deeper nesting with `git` in it asks. `xargs` (its options included) running a commit, directly or through an alias, asks with "can't see xargs arguments; secrets not checked".
- **The command's own config prefixes** (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`) are used when looking up an alias. Earlier `export` / `unset` of them in the same line count too (not out of a subshell or pipeline stage), and they reach nested `bash -c` / `eval` strings. A value from `$…` or a substitution asks. Any shell alias (`!…`) that runs `git` asks. Common git commands (`status`, `log`, `push` …) are recognised without spawning `git --list-cmds`.

## [0.1.4] - 2026-11-25

### Fixed

- **The entry-point check no longer goes silent when `realpath` fails.** `isMain()` (`scripts/is-main.mjs`, a synced copy of `shared/is-main.mjs`) used to return false if resolving a path threw (for example a permission error on a folder in the path), so the hooks (including the secret blocker) did nothing. Now it falls back to comparing the plain resolved paths, the check used before the symlink fix. The worst case is the old behaviour (no symlink support), never a silent no-op.

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
