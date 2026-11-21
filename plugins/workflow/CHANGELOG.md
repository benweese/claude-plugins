# Changelog

All notable changes to the `workflow` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.2.0] - 2026-11-21

### Added

- **`/board`**: shows a GitHub Project's In progress and Ready items, the top Ready issue and its blockers (native "blocked by" links and "Blocked by #x" lines; it says when a source couldn't be read), and offers to start it. Read-only until you say go; then it checks the working tree is clean (asks if not), assigns the issue, moves the card, branches from an up-to-date default branch, and lists the questions to answer before any code.
- `.claude/board.json` (`"version": 1`, `owner` + `project` required; missing or invalid → `/board` stops and prints a template): `repo`, `phaseField`, `maxReady`, `maxInProgress`, `branch`, `statuses`.

## [0.1.0] - 2026-11-20

### Added

- `check`, moved unchanged from the `playwright-qa-agents` plugin (0.10.0). It is now `/workflow:check`.
