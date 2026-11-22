# Sample app

A tiny reading-list app the plugins test themselves against, so their tests and fixtures don't depend on another repo. Node only, no dependencies. All data is made up.

```bash
node examples/sample-app/server.mjs        # http://localhost:4321
node --test examples/sample-app/server.test.mjs   # smoke tests
```

| Route | What it does |
| ----- | ------------ |
| `GET /` | The list and an "Add a book" form (labelled inputs, status and error messages) |
| `GET /a11y-broken` | Accessibility fixture, broken on purpose. axe finds: no `lang`, an image without `alt`, low-contrast text, an unnamed button. Only a code review finds: an input labelled only by its placeholder, a clickable `div` (not keyboard-operable), a skipped heading level, a 16×16 target |
| `GET /api/books` | All books |
| `POST /api/books` `{ "title", "author" }` | Adds a book. 400 with `errors` if a field is missing or the title is over 120 characters |
| `GET /api/books/:id` | One book, or 404 |
| `DELETE /api/books/:id` | Removes it (204), or 404 |

Data lives in memory and resets when the server restarts. Plugin features add fixtures here (for example a page with a missing label) that prove they catch what they should.
