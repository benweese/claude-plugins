# docs

A [Claude Code](https://claude.com/claude-code) plugin from the [benweese marketplace](../../README.md) that keeps a repo's documentation true to the code.

## Install

```bash
claude plugin install docs --marketplace benweese/playwright-ai-qa-agents
```

Or `claude plugin marketplace add benweese/playwright-ai-qa-agents`, then `claude plugin install docs@benweese`. Start a new session afterwards.

## Usage

| Command | What it does |
| ------- | ------------ |
| `/docs sweep [path]` (or just `/docs`) | Rewrites the README so it matches the code, keeps `CLAUDE.md` split into a short root file and folder guides, adds or fixes JSDoc/TSDoc, and removes comments that only restate the code. Docs only: it proves no behaviour changed. A path limits it to that folder |
| `/docs phase <N>` | The end-of-phase docs update: gathers the phase's closed issues and merged PRs, marks the plan, adds the changelog entry, keeps `CLAUDE.md` files within their line budgets, updates the README and runbook if affected, runs the project's extra steps and a privacy check, then opens the "docs: Phase N docs update" PR that closes the docs issue. Needs the GitHub CLI (`gh`) |

`/docs:docs` works too (the full plugin name), and is the one to use if another plugin also has a `/docs`.

`/docs:update-docs` is the old name for `/docs sweep`. It still works in 0.2.0 and is removed in 0.3.0.

## Configure (optional)

Put `.claude/docs.json` in the repo. Every field is optional; a missing file, invalid JSON or a `version` other than `1` means the defaults:

```json
{
  "version": 1,
  "plan": "docs/plan.md",
  "changelog": "CHANGELOG.md",
  "runbook": "docs/ops-runbook.md",
  "milestone": "Phase {n}",
  "docsIssue": "Phase {n}: Docs update",
  "prTitle": "docs: Phase {n} docs update",
  "claudeMdLines": { "root": 50, "other": 40 },
  "extraSteps": []
}
```

`{n}` is the phase number. `extraSteps` are plain-English steps only your project needs (for example "Run the deploy check on staging"); phase mode does them in order, and anything only you can do is listed under "Your part" in the PR.

**Privacy check (phase mode):** if the `privacy` plugin is installed, its scan is used. Otherwise it looks for email addresses, card-like numbers, API keys, tokens and private keys, and dollar amounts only if `.claude/privacy.json` has `"dollarAmounts": true`.

## License

MIT
