# Changelog

All notable changes to the `accessibility` plugin. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version can change behaviour.

## [0.1.0] - 2026-11-22

### Added

- **`/a11y <url | file | components>`**: a one-off axe scan of a page or HTML file while you build it, with the project's own `playwright` and `@axe-core/playwright` (nothing downloaded; skipped with the install line if they're missing), violations in plain English with fixes in your code, then a code review for what scanners miss. Writes no test files; never says "compliant".
- **`a11y-reviewer` agent**: reviews UI code for names and labels, structure, keyboard and focus, ARIA, motion, WCAG 2.2 target size, contrast and reflow, plus the project's own list. Reports with code fixes; edits nothing unless asked.
- **`a11y-contrast <fg> <bg> [AA|AAA]`**: the WCAG contrast ratio and pass/fail for text, large text and UI components.
- `.claude/a11y.json` (`"version": 1`): `level`, `wcag`, `projectList`.
