# component-testing fixture

Existing component tests for the sample app's `BookList` (`src/components/BookList.js`, stories in
`BookList.story.js`, gallery at `playwright/gallery/`), with planted problems:

| Planted | Where | Expected finding |
| ------- | ----- | ---------------- |
| **Untested state** | story `components/BookList/LoadFailed` | no test mounts it: the error state (alert + "Try again", retries recorded) is untested. `qa-components coverage` lists it; the `component-tester` adds the test |
| **Flow in a component test** | `book-list-flow.spec.ts` `#0205` | leaves the gallery for the real app, uses the real API and covers two goals: scope creep for `/review-tests` — move it to e2e |
| **No accessibility checks** | every test | the `component-tester` scans each state it renders (axe, plus keyboard checks on the interactive ones) |

Run by hand: start the sample app (`node examples/sample-app/server.mjs`), copy `tests/` into a scratch Playwright
project whose `baseURL` is `http://localhost:4321/playwright/gallery/index.html`, and ask Claude Code (qa plugin)
for component tests for `BookList` (delete this README there first).
