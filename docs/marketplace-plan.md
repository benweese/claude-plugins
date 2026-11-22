# Marketplace plan

What the `benweese` marketplace will hold, how each plugin is configured per project, and the rules every hook follows. Formats follow the current Claude Code docs: [plugins reference](https://code.claude.com/docs/en/plugins-reference), [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [hooks](https://code.claude.com/docs/en/hooks), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents) and [settings](https://code.claude.com/docs/en/settings).

## Plugins

| Plugin | Status | Contents |
| ------ | ------ | -------- |
| `qa` | 1.5.0 | Works with or without playwright-test-commons (copies its helpers when it's missing). Agents: page-mapper, api/ui test planners and generators, ui-test-healer, test-reviewer, a11y-tester, component-tester. Skills: author-tests, run-spec, bug-report, review-tests, playwright-cli. Hooks (opt-in): lint + `playwright test --list` after test-file edits; auto-review after a green run. Tools: qa-support (helper copies, incl. the `a11y` bundle), qa-requirements, qa-components |
| `docs` | 0.2.0 | `/docs sweep` and `/docs phase N` (`update-docs` kept as a deprecated alias until 0.3.0) |
| `workflow` | 0.2.0 | `/board` (config-driven, read-only until go) and check. Planned: `/release` |
| `accessibility` | 0.1.0 | Helps Claude **build** accessible UI: `/a11y` (one-off axe scan with the project's own Playwright, plain-English fixes), a11y-reviewer agent, `a11y-contrast`. Testing lives in `qa` |
| `privacy` | 0.1.0 | `/privacy-scan`, privacy-reviewer agent, opt-in commit blocker, plain-git hook installer |
| `guardrails` | 0.1.1 | Secret blocker before `git commit` (on by default); opt-in protected files, dangerous-command confirm, lint after edit |

Every plugin folder has `.claude-plugin/plugin.json`, `README.md` and `CHANGELOG.md`, with `agents/`, `skills/` and `hooks/` as needed. Slash commands are skills (the docs recommend `skills/` over `commands/` for new plugins).

## Project config

Each plugin reads an optional file in the project's `.claude/` folder. Every file has a `version` so the format can change later without breaking old files.

```jsonc
// .claude/qa.json
{ "version": 1, "hooks": { "lintAfterEdit": false, "autoReview": false }, "supportDir": "tests/support",
  "a11y": { "wcag": "2.2", "level": "AA" }, "components": { "storiesRoot": "src", "testDir": "tests" } }

// .claude/docs.json
{ "version": 1, "plan": "docs/plan.md", "changelog": "CHANGELOG.md", "runbook": "docs/ops-runbook.md",
  "milestone": "Phase {n}", "docsIssue": "Phase {n}: Docs update", "prTitle": "docs: Phase {n} docs update",
  "claudeMdLines": { "root": 50, "other": 40 }, "extraSteps": [] }

// .claude/board.json
{ "version": 1, "owner": "<github-user>", "project": 1, "repo": null, "phaseField": "Phase", "maxReady": 3, "maxInProgress": 1, "branch": "{number}-{slug}",
  "statuses": { "backlog": "Backlog", "ready": "Ready", "inProgress": "In progress", "review": "Review", "done": "Done" } }

// .claude/a11y.json
{ "version": 1, "level": "AA", "wcag": "2.2", "projectList": null }

// .claude/privacy.json
{ "version": 1, "commitHook": false, "dollarAmounts": false, "patterns": [{ "name": "…", "regex": "…" }], "denylist": null, "allowlist": [] }

// .claude/guardrails.json
{ "version": 1, "secrets": true, "lint": false, "protectedFiles": false, "dangerousCommands": false,
  "protected": [".env*", "*.pem", "*.key", "id_*", "credentials*"], "allow": [".env.example", ".env.sample", ".env.template"], "lintCommand": null }
```

`BENWEESE_GUARDRAILS_OFF="lint,secrets"` turns guardrails features off from the environment.

## Hook rules

- **Opt-in per project.** Claude Code runs a plugin's hooks in every project where the plugin is enabled, and has no per-hook switch. So each hook reads its project config first and does nothing unless the project turns it on. **A missing or invalid config = off.**
- **One exception: the guardrails secret blocker is on by default.** Installing `guardrails` is the opt-in. A project opts out with `"secrets": false` or the env switch. An invalid guardrails config keeps the secret blocker on and warns; everything else in that file counts as off.
- **The privacy commit-blocker is off by default.** Its rules are project-specific.
- Node scripts (cross-platform), no network, fast. Safety hooks block (exit 2, with the reason). A missing tool means a warning that says the scan was skipped, never a silent pass.
- Hook state (for example review hashes) lives in the project's `.claude/<plugin>/` folder, not in `${CLAUDE_PLUGIN_DATA}`, which is shared across projects.
- Each hook has `node:test` tests for match, clean, disabled and missing-tool cases.

## Test bed

`examples/sample-app/` is a tiny app with no dependencies that the plugins' own tests and fixtures run against, so they don't depend on another repo existing. Features add fixtures there that prove they catch what they should.

## Order

Restructure (this) → qa hook, docs, workflow, guardrails, privacy, accessibility, and the qa additions → CI and docs site plumbing → rename the repo to `benweese/claude-plugins` (GitHub redirects the old URL) → migrate the repos that use these plugins → docs update.
