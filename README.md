# benweese Claude Code plugins

[![Validate plugins](https://github.com/benweese/playwright-ai-qa-agents/actions/workflows/validate.yml/badge.svg)](https://github.com/benweese/playwright-ai-qa-agents/actions/workflows/validate.yml)

A [Claude Code](https://claude.com/claude-code) plugin marketplace named **`benweese`**. Each plugin installs on its own as `<plugin>@benweese`.

**[Docs site](https://code.benweese.com/playwright-ai-qa-agents/)** · By **[Ben Weese](https://benweese.com/)**

## Plugins

| Plugin | Version | What it does |
| ------ | ------- | ------------ |
| [qa](plugins/qa/README.md) | 1.2.0 | Plan, generate, run and heal Playwright API and UI tests in TypeScript, with a human review step between plan and code |
| [docs](plugins/docs/README.md) | 0.2.0 | `/docs sweep` (README, `CLAUDE.md`, JSDoc) and `/docs phase N` (end-of-phase docs update + PR) |
| [workflow](plugins/workflow/README.md) | 0.2.0 | `/board` for GitHub Projects (configured per repo) and a lint check |
| [guardrails](plugins/guardrails/README.md) | 0.1.1 | Blocks committing secrets (on by default); opt-in protected files, a confirm step for destructive commands, lint after edit |
| [privacy](plugins/privacy/README.md) | 0.1.0 | `/privacy-scan`, a reviewer agent, an opt-in commit blocker and a plain-git hook for personal data |
| [accessibility](plugins/accessibility/README.md) | 0.1.0 | `/a11y` (axe scan with plain-English fixes), an a11y-reviewer agent and a contrast calculator |

Planned: more for `qa` (review-tests, an a11y testing agent, a component testing agent), `docs` and `workflow`. See [docs/marketplace-plan.md](docs/marketplace-plan.md).

## Install

From a terminal, in the repo you want the plugin in (one step; Claude Code 2.1.275 or later):

```bash
claude plugin install qa --marketplace benweese/playwright-ai-qa-agents
```

Or add the marketplace once, then install any plugin from it:

```bash
claude plugin marketplace add benweese/playwright-ai-qa-agents
claude plugin install qa@benweese
claude plugin install docs@benweese
claude plugin install workflow@benweese
claude plugin install guardrails@benweese
claude plugin install privacy@benweese
claude plugin install accessibility@benweese
```

Add `--scope project` to record a plugin in the repo's `.claude/settings.json` for everyone who opens it. Where your client has the `/plugin` command, `/plugin install <plugin> --marketplace benweese/playwright-ai-qa-agents` does the same.

**Plugins load when a session starts.** Start a new Claude Code session after installing (in VS Code: **Developer: Reload Window**).

**Upgrading from `playwright-qa-agents@playwright-ai-qa-agents` (0.x):** that plugin is now `qa@benweese` 1.0.0. See the [qa changelog](plugins/qa/CHANGELOG.md).

## Hooks are opt-in per project

Claude Code runs a plugin's hooks in every project where the plugin is enabled. So every hook in these plugins reads the project's own config (`.claude/<plugin>.json`) first and does nothing unless that project opts in. A missing or invalid config means **off**. The one exception is the `guardrails` secret blocker, which is on once you install `guardrails` (projects can opt out). Details are in the [marketplace plan](docs/marketplace-plan.md).

## Repo layout

```
.claude-plugin/marketplace.json   the "benweese" marketplace: one entry per plugin (source ./plugins/<name>)
plugins/<name>/                   one plugin each: .claude-plugin/plugin.json, README, CHANGELOG, agents/ skills/ hooks/
examples/sample-app/              a tiny app the plugins test themselves against (no dependencies)
docs/marketplace-plan.md          what's planned, the config files and the hook rules
shared/                           code more than one plugin needs, copied into each by scripts/sync-shared.mjs
scripts/                          docs site build, sync-shared.mjs
.github/workflows/                validate every plugin + the marketplace; publish the docs site
```

## Development

```bash
claude plugin validate .                         # the marketplace
claude plugin validate plugins/<name> --strict   # one plugin
node examples/sample-app/server.mjs              # the sample app on http://localhost:4321
node --test plugins/*/test/*.test.mjs test/*.test.mjs examples/sample-app/server.test.mjs   # all tests
node scripts/sync-shared.mjs                     # after editing shared/ (a test fails if copies differ)
```

**Releasing a plugin:** bump `version` in `plugins/<name>/.claude-plugin/plugin.json` and in its entry in `.claude-plugin/marketplace.json` (CI fails if they differ), add a `CHANGELOG.md` entry, push to `main`, then tag `<name>-v<version>`.

## License

MIT. The `qa` plugin bundles Playwright's `playwright-cli` skill, Apache-2.0, from Microsoft's `@playwright/cli`.
