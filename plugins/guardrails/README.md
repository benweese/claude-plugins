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
| **Dangerous commands** | Off | You're asked first before: a force-push to the repo's default branch (read from git), `git reset --hard`, `git clean -fd` / `-fdx`, `git checkout -- .`, `git restore .`, and `rm -rf` on `/`, `~`, `$HOME` or the repo root |
| **Lint after edit** | Off | After an edit, your `lintCommand` runs on the file (or the project's ESLint for JS/TS files). Errors go back to Claude to fix |

**Secret scanning:** with [gitleaks](https://github.com/gitleaks/gitleaks) installed it uses gitleaks (and says so); otherwise built-in patterns for private keys, AWS keys, GitHub tokens, Anthropic / OpenAI keys, Slack tokens, Google API keys and long `password = "…"`-style values. If gitleaks fails to run, it falls back to the built-in patterns and says that too. Nothing is sent anywhere.

**Which repo a commit runs in.** The secret blocker scans each commit in the repo it will actually run in. It follows `cd`, `pushd`, `env -C`, `sudo -D` and `git -C`, and unwraps common wrappers: `env`, `command`, `sudo` (with its options), `nohup`, `time`, `timeout`, `nice`, `ionice`, `stdbuf`, `chrt`, `taskset`, `setsid`, `exec`, `!` and shell keywords (`if`, `then`, `while`, `do` …), plus `\git` and `/usr/bin/git`, nested in any order. Anything else that mentions `git commit` and can't be parsed, such as `xargs git commit` or `bash -c '… git commit …'`, asks: "can't parse this commit; secrets not checked". When it **can't tell** which repo a commit runs in, it now **asks** instead of letting the commit through unchecked. Examples: `cd "$(git rev-parse --show-toplevel)" && git commit`, `cd "$DIR"`, `cd -`, `popd`, a folder that doesn't exist yet, `GIT_DIR=…`, or a `cd` inside `( … )`. The prompt says "can't tell which repo this commits in; secrets not checked". The hook reads the command text before it runs, so it can't expand variables or run substitutions. Guessing would mean scanning the wrong repo and passing a commit it never checked. An `env -S "…"` string that mentions `git` asks for the same reason ("can't parse env -S").

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
