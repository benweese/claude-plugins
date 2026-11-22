---
name: a11y
description: Check that what you're building is accessible (WCAG 2.2 AA by default) — a one-off axe scan of a page or HTML file with plain-English fixes, plus a code review for what scanners can't see. Use while building or changing UI; it writes no test files.
argument-hint: "<url | path/to/file.html | component or folder to review>"
allowed-tools: Bash(node *) Bash(a11y-contrast *)
---

# a11y

Target: `$ARGUMENTS` (if empty, ask what to check: a running page URL, an HTML file, or components/files).

This helps you **build** accessible UI. It doesn't write tests — lasting checks in a test suite belong to a
testing tool.

1. **A URL or an HTML file:** run the axe scan and read its output:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scan.mjs" $ARGUMENTS
   ```
   Exit 0 = no automated violations, 1 = violations, 2 = couldn't run (say why), 3 = skipped because the project
   doesn't have `playwright` / `@axe-core/playwright` (show the install line it prints; don't install anything
   without asking) — then go straight to step 2.
2. **Review the code** behind the page or the files named: use the `a11y-reviewer` agent's checklist (names and
   labels, alt text, headings and landmarks, keyboard and focus, ARIA, motion, target size, contrast). For colors,
   calculate, don't guess: `a11y-contrast "<foreground>" "<background>"`.
3. **Report**, shortest first, in plain English:
   - each problem: what a person using a screen reader / keyboard / low vision would hit, where it is in the
     source (file:line when you can find it), and the fix as code;
   - then a short "still needs a person" list (screen-reader flow, whether labels make sense, focus order in use).

Never say a page is "compliant" or "accessible" — say "no automated violations found" and list what wasn't
checked. Only edit files if the user asks.

Project settings: `.claude/a11y.json` (`"level"`, `"wcag"`, `"projectList"` — a file with the project's own extra
rules; check those too when it's set).
