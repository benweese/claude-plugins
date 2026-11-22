# privacy

A [Claude Code](https://claude.com/claude-code) plugin from the [benweese marketplace](../../README.md) that keeps personal data out of commits: a scan you can run any time, a reviewer agent for what patterns miss, an opt-in commit blocker, and a plain-git hook for commits made outside Claude.

## Install

```bash
claude plugin install privacy --marketplace benweese/playwright-ai-qa-agents
```

Or `claude plugin marketplace add benweese/playwright-ai-qa-agents`, then `claude plugin install privacy@benweese`. Start a new session afterwards.

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
