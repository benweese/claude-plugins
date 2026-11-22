# review-tests fixture

A made-up task for the qa plugin's `/review-tests`: the saved request, the plan the authoring agent wrote, and a spec
with planted problems. The reviewer should report:

| Planted | Where | Expected finding |
| ------- | ----- | ---------------- |
| **Gap** | R4 (title over 120 characters → 400) | no test |
| **Partial** | R3 (missing title **or author** → 400) | only a missing title is tested |
| **Weak test** | `#0102 adds a book` | asserts only `status < 500`; would pass if the book weren't saved |
| **Scope creep** | `#0104 removes a book` | DELETE isn't in the request |
| **Plan vs requirements** | `plans/books-api.md` | the plan dropped "or author" from R3 and added a delete scenario |

`.claude/qa/requirements.md` is in the qa-requirements format (the one source of truth). Run it by hand: copy this
folder into a git repo on a branch named `main` (delete this README there, so the reviewer can't read the answers),
start Claude Code with the qa plugin, and run `/review-tests`.
