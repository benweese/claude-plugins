# Changelog

All notable changes to the `accessibility` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.1.2] - 2026-11-25

### Fixed

- **The entry-point check no longer goes silent when `realpath` fails.** `isMain()` (`scripts/is-main.mjs`, a synced copy of `shared/is-main.mjs`) used to return false if resolving a path threw (for example a permission error on a folder in the path), so the scan script and `a11y-contrast` did nothing. Now it falls back to comparing the plain resolved paths, the check used before the symlink fix. The worst case is the old behaviour (no symlink support), never a silent no-op.

## [0.1.1] - 2026-11-25

### Fixed

- **The `/a11y` scan script and `a11y-contrast` did nothing when run through a symlinked path** (a symlinked file or plugin folder): the "am I the script being run?" check compared `process.argv[1]`, which keeps the symlink, with the resolved `import.meta.url`. Both now use `isMain()` from `scripts/is-main.mjs` (a synced copy of `shared/is-main.mjs`), which compares real paths.
- They set `process.exitCode` and return instead of calling `process.exit()`, so output can finish writing. Exit codes are unchanged; `a11y-contrast` with no colours prints only the usage line (exit 2).
- `bin/package.json` (`{"type": "module"}`): `a11y-contrast` loads as an ES module without relying on Node's module syntax detection.
- Tests: both give the same result directly, through a symlinked file and through a symlinked folder; a source check fails on `process.exit()` or a direct `process.argv[1]` comparison.

## [0.1.0] - 2026-11-22

### Added

- **`/a11y <url | file | components>`**: a one-off axe scan of a page or HTML file while you build it, with the project's own `playwright` and `@axe-core/playwright` (nothing downloaded; skipped with the install line if they're missing), violations in plain English with fixes in your code, then a code review for what scanners miss. Writes no test files; never says "compliant".
- **`a11y-reviewer` agent**: reviews UI code for names and labels, structure, keyboard and focus, ARIA, motion, WCAG 2.2 target size, contrast and reflow, plus the project's own list. Reports with code fixes; edits nothing unless asked.
- **`a11y-contrast <fg> <bg> [AA|AAA]`**: the WCAG contrast ratio and pass/fail for text, large text and UI components.
- `.claude/a11y.json` (`"version": 1`): `level`, `wcag`, `projectList`.
