# accessibility

A [Claude Code](https://claude.com/claude-code) plugin from the [benweese marketplace](../../README.md) that helps Claude **build** accessible UI: a quick axe scan of what you just made, a code review for what scanners can't see, and a contrast calculator. WCAG 2.2 AA by default. (Lasting accessibility checks inside a test suite belong to a testing tool, not this plugin.)

## Install

```bash
claude plugin install accessibility --marketplace benweese/claude-plugins
```

Or `claude plugin marketplace add benweese/claude-plugins`, then `claude plugin install accessibility@benweese`. Start a new session afterwards.

## Use it

| | |
| - | - |
| `/a11y http://localhost:3000/checkout` | Scans a running page with axe, explains each violation in plain English with the fix in your code, then reviews the code behind it |
| `/a11y public/signup.html` | The same for a local HTML file |
| `/a11y src/components/Modal.tsx` | A code review only (no page to scan) |
| `a11y-reviewer` agent | Reviews a diff or components: names and labels, headings and landmarks, keyboard and focus (incl. modals and Escape), ARIA, motion, 24×24 targets (WCAG 2.2), contrast, reflow. Reports with code fixes; edits nothing unless asked |
| `a11y-contrast "#767676" "#ffffff"` | Contrast ratio and pass/fail for normal text, large text and UI components (add `AAA` for AAA) |

**The scan** uses your project's own `playwright` (or `@playwright/test`) and `@axe-core/playwright` — nothing is downloaded. If they aren't installed, it says the scan was skipped, shows the install line (`npm install --save-dev @playwright/test @axe-core/playwright && npx playwright install chromium`) and does the code review instead. It writes no test files.

**What automation can't tell you:** axe finds only part of WCAG. For example, it accepts a placeholder as a label and can't see that a clickable `<div>` isn't keyboard-operable — the code review catches those. Screen-reader flow, focus order in real use and whether labels make sense still need a person, and the report says so. It never calls a page "compliant" — only "no automated violations found".

## Configure (optional)

`.claude/a11y.json`:

```json
{ "version": 1, "level": "AA", "wcag": "2.2", "projectList": "docs/accessibility.md" }
```

- `level`: `A`, `AA` (default) or `AAA`; `wcag`: `2.0`, `2.1` or `2.2` (default) — they pick the axe rule tags.
- `projectList`: a file (or a section of one) with your project's own accessibility rules; the review checks those too.
- A missing or invalid file means WCAG 2.2 AA.

## License

MIT
