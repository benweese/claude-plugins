---
name: review-tests
description: Check the tests for the current task against the original request (not a summary): gaps, scope creep, weak tests, ambiguous requirements. Runs the test-reviewer agent in a fresh context; report only. Use after tests go green, or when the user asks to review tests against the requirements.
argument-hint: "[issue <n> | file <path>]"
allowed-tools: Bash(qa-requirements *)
---

# review-tests

Arguments: `$ARGUMENTS`

1. **Get the requirement.** The only source of truth is `.claude/qa/requirements.md`.
   - `issue <n>` → `qa-requirements save issue <n>`; `file <path>` → `qa-requirements save file <path>`.
   - No arguments → `qa-requirements show`. If it's saved and on this branch, use it.
   - **More than one source and they disagree** (e.g. a saved chat request and an issue) → stop and ask the user
     which one wins; save that one.
   - **Nothing written down** (e.g. "go test this page") → restate what you understand as a numbered list of
     requirements, get the user's **yes**, then save it verbatim with `qa-requirements save chat` (stdin).
   - It says the requirement is from another branch → that's another task: get this task's requirement first.
   - Pass on any warning it prints (e.g. requirements.md isn't gitignored).
2. **Review in a fresh context:** run the **test-reviewer** agent. Tell it only the feature (or spec paths) to look at;
   it reads requirements.md itself. Don't summarise the requirement for it.
3. **Relay its report** as it is: decisions first, then the tables.
4. Record the review: `qa-requirements reviewed`.

**Report only.** Don't edit, add or delete any test until the user approves a decision.
