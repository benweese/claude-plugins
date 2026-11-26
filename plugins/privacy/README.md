# privacy

A [Claude Code](https://claude.com/claude-code) plugin from the [benweese marketplace](../../README.md) that keeps personal data out of commits: a scan you can run any time, a reviewer agent for what patterns miss, an opt-in commit blocker, and a plain-git hook for commits made outside Claude.

## Install

```bash
claude plugin install privacy --marketplace benweese/claude-plugins
```

Or `claude plugin marketplace add benweese/claude-plugins`, then `claude plugin install privacy@benweese`. Start a new session afterwards.

## What it finds

| Detector | Default | Notes |
| -------- | ------- | ----- |
| Email addresses | on | `example.com/.org/.net`, `*.invalid`, `*.test`, `*.example`, `noreply` addresses are skipped |
| Card numbers | on | 13–19 digits that pass the Luhn check |
| SSN-like numbers | on | `ddd-dd-dddd`; never-issued `000-`, `666-`, `9xx-` skipped |
| US phone numbers | on | common formats; `555-01xx` (reserved for fiction) skipped |
| Dollar amounts | **off** | turn on with `"dollarAmounts": true` |
| Custom patterns | — | your regexes |
| Denylist | — | your own values (names, streets, last 4 digits…) |

Matched values are **never printed** — reports say `file:line  detector` (a denylist hit says `denylist entry 3`). There's no date or birthdate detector: put real birthdates in your denylist.

## Use it

| | |
| - | - |
| `/privacy-scan` | Every tracked file |
| `/privacy-scan staged` | What's staged for the next commit |
| `/privacy-scan docs/ src/x.ts` | Those folders or files |
| `/privacy-scan refresh` | Download your URL denylist into the local cache |
| `privacy-reviewer` agent | Reviews a diff or PR for what patterns miss: names in prose or fixtures, addresses, birthdates, real-looking amounts, partial account numbers. Report only |

**Commit blocker (opt-in):** with `"commitHook": true`, before Claude runs `git commit` it scans what that commit will contain — the staged changes, tracked changes for `git commit -a`, and the paths a chained `git add … && git commit` stages — and blocks on a match. It's off by default because its rules are project-specific (a `$5` in someone's README isn't personal data).

**Which repo a commit runs in.** The commit blocker scans each commit in the repo it will actually run in. It follows `cd`, `pushd`, `env -C`, `sudo -D` and `git -C`, and unwraps common wrappers: `env`, `command`, `sudo` (with its options), `nohup`, `time`, `timeout`, `nice`, `ionice`, `stdbuf`, `chrt`, `taskset`, `setsid`, `exec`, `!` and shell keywords (`if`, `then`, `while`, `do` …), plus `\git` and `/usr/bin/git`, nested in any order. `bash -c '…'` (also `sh`, `zsh`, `dash`, `ksh`) and `eval '…'` strings are parsed like command lines of their own, aliases included, up to 3 levels deep. Deeper nesting with `git` in it asks. `xargs` running a commit asks with "can't see xargs arguments; personal data not checked", because the arguments come from input the hook can't see. Anything else that mentions `git commit` and can't be parsed asks: "can't parse this commit; personal data not checked". **Git aliases** are expanded the way git does: `git ci` with `alias.ci = commit` (in the repo's, your global or the system config, or an inline `git -c alias.ci=commit`) is checked as a commit, and the alias's own arguments count (`alias.ci = commit -a`). A shell alias (`!…`) that runs `git` at all (it can commit without the word `commit` appearing, e.g. `!f() { git "$@"; }; f`), an alias loop, or an alias lookup that takes too long asks: "can't parse this commit; personal data not checked". The command's own `GIT_CONFIG_GLOBAL=…`, `HOME=…` or `GIT_CONFIG_KEY_0=…` prefixes count when looking up an alias, and so do earlier `export` / `unset` of those variables in the same command line. They carry over like `cd` does, except out of a `( … )` subshell or a pipeline stage. A value set from a variable or substitution (`GIT_CONFIG_GLOBAL=$X git ci`) asks. A script run with `source` / `.` isn't followed. An alias in a repo that can't be determined (`cd "$X" && git ci`) asks too. Not covered: a shell alias that calls another alias (`!git ci`), and aliases for `push` (the dangerous-command checks don't expand aliases). Your project's `.claude/privacy.json` and denylist apply to every commit. When it **can't tell** which repo a commit runs in, it now **asks** instead of letting the commit through unchecked. Examples: `cd "$(git rev-parse --show-toplevel)" && git commit`, `cd "$DIR"`, `cd -`, `popd`, a folder that doesn't exist yet, or a `cd` inside `( … )`. The prompt says "can't tell which repo this commits in; personal data not checked". The hook reads the command text before it runs, so it can't expand variables or run substitutions. Guessing would mean scanning the wrong repo and passing a commit it never checked. An `env -S "…"` string that mentions `git` asks for the same reason.

**Time limit.** The commit scan gets 20 seconds per command; the hook's own timeout is 30 s. If git doesn't answer in time (a hung process, a slow network drive), Claude Code asks you instead of running the commit: "personal data scan timed out; personal data not checked". The hook doesn't set `"onFailure": "block"`. privacy is opt-in, but the hook runs on every Bash command, so blocking on a hook failure would let a crash stop Bash even in projects that never turned on `commitHook`. As a result, if the hook itself fails (it crashes, or runs past its 30 s timeout), Claude Code still runs the command; the 20-second scan limit is what asks first.

**Commits outside Claude:** run `install-privacy-git-hook` in the repo (Claude can run it too — it's on Claude's PATH while the plugin is enabled). It copies a self-contained scanner into git's hooks folder and reads your config and denylist at commit time. It respects `core.hooksPath`, stops with instructions for husky, won't replace an existing `pre-commit` hook without `--force`, and only says "Installed" after checking git will run it. Re-run it after updating the plugin. `git commit --no-verify` skips it.

## Configure

`.claude/privacy.json` (a missing or invalid file means the commit blocker is off):

```json
{
  "version": 1,
  "commitHook": true,
  "dollarAmounts": false,
  "patterns": [{ "name": "employee id", "regex": "EMP-\\d{5}" }],
  "denylist": ".claude/privacy-denylist.txt",
  "allowlist": ["support@example.com", "/^\\+1 800/"]
}
```

**Denylist:** one value per line, `#` comments, case-insensitive. Words match whole words (`Ky` doesn't hit `sky`); numbers need digit boundaries (`4321` doesn't hit `14321`). It can be:

- a **local path** — keep it out of the repo or gitignored (you're told if it isn't);
- a **URL** — `https://…` or a private GitHub file as `gh:owner/repo/path` (read with your `gh` login). Hooks never go online: `/privacy-scan refresh` downloads it into `.claude/privacy/denylist.cache` (gitignore it). A missing or 7+ day old cache is reported, never silently skipped.

## License

MIT
