# workflow

A [Claude Code](https://claude.com/claude-code) plugin from the [benweese marketplace](../../README.md) with day-to-day repo workflow skills.

## Install

```bash
claude plugin install workflow --marketplace benweese/playwright-ai-qa-agents
```

Or `claude plugin marketplace add benweese/playwright-ai-qa-agents`, then `claude plugin install workflow@benweese`. Start a new session afterwards.

## Skills

| Skill | Use |
| ----- | --- |
| `/workflow:check [fix]` | Run the repo's lint, optionally auto-fixing |

Coming next: a config-driven `/board` for GitHub Projects (statuses, max in Ready and branch names from `.claude/board.json`; read-only until you say go). See the [marketplace plan](../../docs/marketplace-plan.md).

## License

MIT
