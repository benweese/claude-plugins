# workflow

A [Claude Code](https://claude.com/claude-code) plugin from the [benweese marketplace](../../README.md) with day-to-day repo workflow skills.

## Install

```bash
claude plugin install workflow --marketplace benweese/claude-plugins
```

Or `claude plugin marketplace add benweese/claude-plugins`, then `claude plugin install workflow@benweese`. Start a new session afterwards.

## Skills

| Skill | Use |
| ----- | --- |
| `/board [issue]` | Shows your GitHub Project's In progress and Ready items, the top Ready issue (or the one you name) and its blockers, and offers to start it. **Read-only until you say go.** Then it checks the working tree is clean (and asks if it isn't), assigns the issue, moves the card to In progress, branches from an up-to-date default branch, and lists the questions to answer before any code |
| `/workflow:check [fix]` | Runs the repo's lint (`npm run lint`), or `npm run lint:fix` with `fix`, and reports what's left |

`/workflow:board` works too, if another plugin also has a `/board`.

Planned: `/release`.

## Configure `/board`

`/board` needs `.claude/board.json` in the repo. Without a valid one it stops and prints this template; it never guesses a project:

```json
{
  "version": 1,
  "owner": "<github-user-or-org>",
  "project": 1,
  "repo": null,
  "phaseField": "Phase",
  "maxReady": 3,
  "maxInProgress": 1,
  "branch": "{number}-{slug}",
  "statuses": { "backlog": "Backlog", "ready": "Ready", "inProgress": "In progress", "review": "Review", "done": "Done" }
}
```

- `owner` + `project`: the Project's owner and number (from its URL). Required.
- `repo`: `owner/name` of the issues' repo; `null` = the current repo.
- `phaseField`: a single-select field to sort by (numbers first, then other values); `null` = sort by issue number.
- `maxReady` / `maxInProgress`: limits it flags when exceeded.
- `branch`: `{number}` and `{slug}` (short kebab-case title).
- `statuses`: your Project's Status option names.

It needs the GitHub CLI logged in with the `project` scope (`gh auth refresh -s project`).

**Blockers:** it reads GitHub's native "blocked by" links (`gh issue view --json blockedBy`, or the REST `dependencies/blocked_by` endpoint) and "Blocked by #x" lines in the issue body. If it can't read one of those, it says so instead of reporting "no blockers".

## License

MIT
