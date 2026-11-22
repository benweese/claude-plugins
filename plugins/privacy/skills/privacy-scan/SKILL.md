---
name: privacy-scan
description: Scan files or the staged changes for personal data (emails, card numbers, SSN-like numbers, US phones, optional dollar amounts, custom patterns and a denylist), or refresh a URL denylist. Values are never shown. Use when the user asks to check for personal data or PII before committing or publishing.
argument-hint: "[staged | refresh | path …]"
allowed-tools: Bash(node *)
---

# privacy-scan

Run the scanner and report its output as-is (it never prints matched values):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan.mjs" $ARGUMENTS
```

- no arguments: every tracked file; `staged`: what's staged; paths: those files or folders;
  `refresh`: download the URL denylist set in `.claude/privacy.json` into `.claude/privacy/denylist.cache`.
- Exit 0 = clean, 1 = findings, 2 = couldn't run (say why).

For each finding, open the file at that line and suggest a fix: replace it with made-up data, move it out of
the repo, or (if it's not personal data) add it to the `allowlist`. **Never paste a matched value into the
conversation, a commit message or a PR.** Don't edit files unless the user asks.

For personal data the patterns can't see (names in prose, real-looking amounts, addresses), suggest the
`privacy-reviewer` agent.
