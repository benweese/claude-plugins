<!-- qa-requirements v1 -->
source: chat
branch: main
saved: 2026-11-01T15:00:00.000Z
---
Write API tests for the reading list:
1. GET /api/books returns every book, each with an id, a title and an author.
2. POST /api/books with a title and an author adds the book and answers 201 with the new book.
3. A missing title or author is rejected with 400 and an error message.
4. A title over 120 characters is rejected with 400.
