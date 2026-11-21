# docs

A [Claude Code](https://claude.com/claude-code) plugin from the [benweese marketplace](../../README.md) that keeps a repo's documentation up to date.

## Install

```bash
claude plugin install docs --marketplace benweese/playwright-ai-qa-agents
```

Or `claude plugin marketplace add benweese/playwright-ai-qa-agents`, then `claude plugin install docs@benweese`. Start a new session afterwards.

## Skills

| Skill | Use |
| ----- | --- |
| `/docs:update-docs [path]` | Bring the docs up to date: a detailed README that matches the code, `CLAUDE.md` split into a root file and folder guides, JSDoc on everything, and only comments that explain why. Proves no behaviour changed |

Coming next: one `/docs` skill with two modes, `sweep` (the above) and `phase` (end-of-phase docs: plan status, changelog, CLAUDE.md, README, runbook, a privacy check and the PR), configured per repo in `.claude/docs.json`. See the [marketplace plan](../../docs/marketplace-plan.md).

## License

MIT
