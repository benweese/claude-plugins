# Review rules

The rules every Claude PR review follows, in this repo and in Ben's other repos that run one. Each repo's `.github/workflows/claude-review.yml` prompt carries a **copy** of the block below, next to that repo's own checklist.

- **This file is the single source.** It's copied text, not an include. Change the rules here first, then paste the new block into each repo's `claude-review.yml`, one PR per repo.
- **Every copy starts with the line** `# from benweese/claude-plugins docs/review-rules.md`, so a reader can find the source. In a YAML `prompt: |` block that line is prompt text, not a YAML comment.
- **In this repo, a test** (`test/review-rules.test.mjs`) checks that `claude-review.yml` holds the block word for word.
- **Status:** this repo uses it. The other repos get it with their planned migrations.

Two of the rules (false positives; one review) are patterns from [ChrisTitusTech/titstack](https://github.com/ChrisTitusTech/titstack) `docs/WORKFLOW.md`. No text is copied.

## The block

Paste everything inside the fence, indented to match the surrounding `prompt: |` text:

```text
# from benweese/claude-plugins docs/review-rules.md
Review rules (every review follows all of them):
- Verified: check each finding against the current diff and the code it touches. Report only what the diff
  shows; a finding about unchanged code needs the changed line that triggers it.
- Defects: report real defects: wrong behaviour, a check that can be skipped, data loss, a security or privacy
  leak, a missing test for changed behaviour. Lead with these; put style and wording last, marked as nits.
- Unsure: when you can't confirm a finding, say so in the comment and name what would settle it (a test, a
  command, a file to read).
- False positives: when a suspected problem turns out to be correct code, say in one line why it's correct and
  leave the code as it is.
- Read-only: post comments, and only comments. The branch stays exactly as you found it: no pushes, commits or
  file edits.
- One review: this run is the whole review. Do the checks yourself, in this run; start no other review, review
  command or review workflow from it.
- Tests: flag any PR where a test heal changed an `expect` (the assertion itself, not a locator or a wait), and
  any hard `expect` with no `// precondition` comment explaining why it must stop the test.
```
