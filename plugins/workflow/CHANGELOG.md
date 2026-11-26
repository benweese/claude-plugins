# Changelog

All notable changes to the `workflow` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.3.2] - 2026-11-25

### Fixed

- **The entry-point check no longer goes silent when `realpath` fails.** `isMain()` (`scripts/is-main.mjs`, a synced copy of `shared/is-main.mjs`) used to return false if resolving a path threw (for example a permission error on a folder in the path), so the session-rules hook did nothing. Now it falls back to comparing the plain resolved paths, the check used before the symlink fix. The worst case is the old behaviour (no symlink support), never a silent no-op.

## [0.3.1] - 2026-11-25

### Changed

- The session-rules hook's symlink-safe entry-point check (`isMain()`) moved out of `scripts/principles.mjs` into `scripts/is-main.mjs`, a synced copy of `shared/is-main.mjs` that every plugin now uses. The caller passes its own `import.meta.url`; there is no default. No behaviour change: the hook still works through a symlinked path.

## [0.3.0] - 2026-11-25

### Added

- **Session rules** (opt-in `SessionStart` hook on startup, resume, `/clear` and compaction): adds 8 working rules to Claude's context, such as "verify before saying done" and "if a check fails, fix the cause; never weaken or skip the check". Turned on by a committed `.claude/workflow.json` with `"version": 1` and `"principles": true`. No file, or `principles` false/absent → nothing; an invalid file (including `principles` that isn't a boolean) → a warning shown to the user, no rules. Unknown keys are ignored; a leading BOM is fine; the hook works when run through a symlinked path.
- The rules follow patterns from [ChrisTitusTech/titstack](https://github.com/ChrisTitusTech/titstack)'s workflow docs (patterns only; nothing copied).

## [0.2.0] - 2026-11-21

### Added

- **`/board`**: shows a GitHub Project's In progress and Ready items, the top Ready issue and its blockers (native "blocked by" links and "Blocked by #x" lines; it says when a source couldn't be read), and offers to start it. Read-only until you say go; then it checks the working tree is clean (asks if not), assigns the issue, moves the card, branches from an up-to-date default branch, and lists the questions to answer before any code.
- `.claude/board.json` (`"version": 1`, `owner` + `project` required; missing or invalid → `/board` stops and prints a template): `repo`, `phaseField`, `maxReady`, `maxInProgress`, `branch`, `statuses`.

## [0.1.0] - 2026-11-20

### Added

- `check`, moved unchanged from the `playwright-qa-agents` plugin (0.10.0). It is now `/workflow:check`.
