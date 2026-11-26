# guardrails

A [Claude Code](https://claude.com/claude-code) plugin from the [benweese marketplace](../../README.md): safety hooks that stop Claude from committing secrets and, if you turn them on, from touching secret files, running destructive commands without asking, or leaving lint errors behind.

## Install

```bash
claude plugin install guardrails --marketplace benweese/claude-plugins
```

Or `claude plugin marketplace add benweese/claude-plugins`, then `claude plugin install guardrails@benweese`. Start a new session afterwards.

## What it does

| Guardrail | Default | What happens |
| --------- | ------- | ------------ |
| **Secret blocker** | **On** (installing the plugin is the opt-in) | Before Claude runs `git commit`, it scans what that commit will contain: the staged changes, plus tracked changes for `git commit -a` / `--all`, plus the paths a chained `git add … && git commit` stages. A match blocks the commit and shows the file, line and rule, with the secret masked |
| **Protected files** | Off | Claude can't read or change `.env*`, `*.pem`, `*.key`, `id_*` or `credentials*` (reading one would put the secret into the conversation). `.env.example`, `.env.sample` and `.env.template` are allowed |
| **Dangerous commands** | Off | **Blocked:** merging a pull request (`gh pr merge`, or `gh api` to the merge endpoint or the merge / auto-merge GraphQL mutations), any `git push` to the repo's default branch (read from git), and plain force-pushes (`--force`, `-f`, `+branch`) to any other branch. **Asked first:** `git reset --hard`, `git clean -fd` / `-fdx`, `git checkout -- .`, `git restore .`, and `rm -rf` on `/`, `~`, `$HOME` or the repo root |
| **Lint after edit** | Off | After an edit, your `lintCommand` runs on the file (or the project's ESLint for JS/TS files). Errors go back to Claude to fix |

**Secret scanning:** with [gitleaks](https://github.com/gitleaks/gitleaks) installed it uses gitleaks (and says so); otherwise built-in patterns for private keys, AWS keys, GitHub tokens, Anthropic / OpenAI keys, Slack tokens, Google API keys and long `password = "…"`-style values. If gitleaks fails to run, it falls back to the built-in patterns and says that too. Nothing is sent anywhere.

**Which repo a commit runs in.** The secret blocker scans each commit in the repo it will actually run in. It follows `cd`, `pushd`, `env -C`, `sudo -D` and `git -C`, and unwraps common wrappers: `env`, `command`, `sudo` (with its options), `nohup`, `time`, `timeout`, `nice`, `ionice`, `stdbuf`, `chrt`, `taskset`, `setsid`, `exec`, `!` and shell keywords (`if`, `then`, `while`, `do` …), plus `\git` and `/usr/bin/git`, nested in any order. `bash -c '…'` (also `sh`, `zsh`, `dash`, `ksh`) and `eval '…'` strings are parsed like command lines of their own, aliases included, up to 3 levels deep. Deeper nesting with `git` in it asks. `xargs` running a commit asks with "can't see xargs arguments; secrets not checked", because the arguments come from input the hook can't see. Anything else that mentions `git commit` and can't be parsed asks: "can't parse this commit; secrets not checked". **Git aliases** are expanded the way git does: `git ci` with `alias.ci = commit` (in the repo's, your global or the system config, or an inline `git -c alias.ci=commit`) is checked as a commit, and the alias's own arguments count (`alias.ci = commit -a`). A shell alias (`!…`) that runs `git` at all (it can commit without the word `commit` appearing, e.g. `!f() { git "$@"; }; f`), an alias loop, or an alias lookup that takes too long asks: "can't parse this commit; secrets not checked". The command's own `GIT_CONFIG_GLOBAL=…`, `HOME=…` or `GIT_CONFIG_KEY_0=…` prefixes count when looking up an alias, and so do earlier `export` / `unset` of those variables in the same command line. They carry over like `cd` does, except out of a `( … )` subshell or a pipeline stage. A value set from a variable or substitution (`GIT_CONFIG_GLOBAL=$X git ci`) asks. A script run with `source` / `.` isn't followed. An alias in a repo that can't be determined (`cd "$X" && git ci`) asks too. Not covered: a shell alias that calls another alias (`!git ci`), and aliases for `push` (the dangerous-command checks don't expand aliases). When it **can't tell** which repo a commit runs in, it now **asks** instead of letting the commit through unchecked. Examples: `cd "$(git rev-parse --show-toplevel)" && git commit`, `cd "$DIR"`, `cd -`, `popd`, a folder that doesn't exist yet, `GIT_DIR=…`, or a `cd` inside `( … )`. The prompt says "can't tell which repo this commits in; secrets not checked". The hook reads the command text before it runs, so it can't expand variables or run substitutions. Guessing would mean scanning the wrong repo and passing a commit it never checked. An `env -S "…"` string that mentions `git` asks for the same reason ("can't parse env -S").

**Time limit.** The secret scan gets 40 seconds per command; the hook's own timeout is 60 s. If git or gitleaks doesn't answer in time (a hung process, a slow network drive), Claude Code asks you instead of running the commit: "secret scan timed out; secrets not checked". If only gitleaks runs out of time, the built-in patterns check the commit instead, and the message says so. On Claude Code **v2.1.295 or later**, the hook also sets `"onFailure": "block"`: if the hook itself fails (it times out, crashes, or `node` can't start), the Bash command is blocked instead of run. That covers every Bash command, not only commits, because the hook runs on all of them. Older versions ignore `onFailure`. `claude plugin validate` on 2.1.200, 2.1.250 and 2.1.294 accepts the key without a warning, and the 2.1.294 hook schema drops unknown keys. A live session on an older version wasn't run. On those versions a failed hook still lets the command through, but the 40-second scan limit still asks.

**Merges and pushes (dangerous commands).** With `"dangerousCommands": true`, Claude can't merge a PR or push to the default branch; a person has to. The hook denies the command and tells Claude why.
- **Merges:** `gh pr merge` with any flags (including `--auto`), `gh api` calls to `repos/<owner>/<repo>/pulls/<n>/merge`, and `gh api graphql` calls whose query contains `mergePullRequest` or `enablePullRequestAutoMerge`.
- **Pushes to the default branch, forced or not:** a named branch (`main`, `+main`, `HEAD:main`, `refs/heads/main`), deleting it (`:main`, `--delete main`, `-d`), `--all` and `--mirror`, and a bare `git push` or `git push origin HEAD` while the default branch is checked out. A bare push from a branch whose upstream is the default branch counts too, and so does `push.default=matching`. `--force-with-lease` doesn't make a default-branch push OK.
- **Other branches:** a plain `--force` / `-f` / `+branch` push is blocked; use `--force-with-lease`. Normal pushes, deletes and tag pushes are fine.
- **How it reads the command:** the default branch comes from `origin/HEAD`, else `init.defaultBranch` (no network); when neither is set, both `main` and `master` count. The checks follow chains (`&&`, `||`, `;`, `|`), `cd`, `git -C`, `git -c …`, wrappers like `env` and `sudo`, and `bash -c` / `sh -c` strings (3 deep). Values of push options (`-o ci.skip`, `--push-option`, `--repo`, `--receive-pack`) aren't mistaken for the remote. When the folder can't be determined (`cd "$X" && git push`) and the branch depends on it, it asks.

**This is a speed bump, not a wall.** It reads the command text, so `eval`, git aliases for `push`, `xargs`, scripts and `remote.<name>.push` settings get past it. The real protection is a **branch ruleset on `main`** in GitHub: require a pull request and block force pushes.

**Limits:** it only sees commands Claude runs, not commits you make in your own terminal. Shell commands that read files (`cat .env`) aren't checked by the protected-files guard, and the dangerous-command list is exactly the one above.

## Configure

`.claude/guardrails.json` in the repo (all fields optional):

```json
{
  "version": 1,
  "secrets": true,
  "protectedFiles": false,
  "dangerousCommands": false,
  "lint": false,
  "protected": [".env*", "*.pem", "*.key", "id_*", "credentials*"],
  "allow": [".env.example", ".env.sample", ".env.template"],
  "lintCommand": null
}
```

- A **missing** file: the secret blocker is on, everything else off.
- An **invalid** file (bad JSON, or `version` isn't `1`): the same, plus a warning — the secret blocker stays on, the safe direction.
- `protected` / `allow`: globs (`*` = anything except `/`) matched against the file name and its path in the repo.
- `lintCommand`: a shell command; `{file}` is replaced with the edited file, e.g. `"npx --no-install eslint {file}"`.

Turn features off from the environment with `BENWEESE_GUARDRAILS_OFF="secrets,lint,protected,dangerous"` (any of them).

If the `qa` plugin's test-file hook is on in the repo, lint after edit leaves `*.spec.*` / `*.test.*` files to it, so they aren't linted twice.

## License

MIT
