---
name: board
description: Show a GitHub Project board (In progress + Ready), the top Ready issue and its blockers, and offer to start it. Read-only until the user says go; then assigns, moves the card, creates the branch and lists the questions to answer before any code. Configured per repo in .claude/board.json.
argument-hint: "[issue number to look at instead of the top Ready one]"
disable-model-invocation: true
---

# board

**Read-only until the user says go.** Never start an issue in Backlog unless the user names it.
Uses the GitHub CLI (`gh`, logged in with the `project` scope). If it isn't available, stop and say so.

## 0. Config

Read `.claude/board.json`. It must be valid JSON with `"version": 1`, an `owner` and a `project` number. If the
file is missing or invalid, **stop**: say what's wrong and print this template to copy. Never guess an owner
or a project.

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

`repo` null = the current repo (`gh repo view --json nameWithOwner`). `phaseField` null = sort by issue number
only. Status names are the Project's own option names.

**Working with `gh` output:** save JSON to a temp file, then run `jq` on the file (piping it through `echo`
can mangle escapes). **Reads** may be retried freely after a network error. **Writes** (assign, move a card,
create a branch): after a failure, re-check the current state first and retry only if the write didn't land.

## 1. The board

```bash
gh project item-list <project> --owner <owner> --format json --limit 1000 > "$TMP/items.json"
```

Show the **In progress** and **Ready** items as a short table: number, phase (if `phaseField`), title,
labels. Sort by phase, then issue number; numeric phases first in number order, then other phase values
(e.g. "Tooling") alphabetically, then items with no phase. Flag Ready over `maxReady` and In progress over
`maxInProgress`. Mention items in Review too, in one line.

## 2. The top Ready issue

The first Ready item in that order (or the issue number the user gave). Show it in full:
`gh issue view <n> --repo <repo>` (title, labels, milestone, body).

**Blockers** — check both, and say which sources were read:

1. Native "blocked by" links: `gh issue view <n> --repo <repo> --json blockedBy`, or the REST endpoint
   `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` (`gh api …`).
2. "Blocked by #x" lines in the issue body, then each one's state.

An open blocker is shown, and the issue is **not** offered for start. If the native links can't be read
(old `gh`, no access), say so plainly and use the body lines only — never report "no blockers" when a source
couldn't be checked.

If nothing is Ready, say so and suggest the next Backlog item, without starting it.

## 3. Offer, then wait

Offer to start it and stop. Only after the user says go:

1. **Clean tree first:** `git status --porcelain`. If anything is uncommitted, **stop and ask** what to do.
   Never stash, carry over or discard changes on your own.
2. Assign it: `gh issue edit <n> --repo <repo> --add-assignee @me`.
3. Move the card to the `inProgress` status: the Status field and option ids from
   `gh project field-list <project> --owner <owner> --format json`, the item id from step 1, the project id
   from `gh project view <project> --owner <owner> --format json --jq .id`, then
   `gh project item-edit --id <item> --project-id <project id> --field-id <status field> --single-select-option-id <option>`.
4. Branch from an up-to-date default branch: switch to it, pull, then create the branch named by `branch`
   (`{number}` = the issue number, `{slug}` = a short kebab-case form of the title).
5. **Things I need from the user:** read the issue, the code it touches and any plan or docs it points to,
   then list the open questions and the assumptions you'd otherwise make — numbered, each with your
   recommendation. **Wait for answers before writing any code.**
