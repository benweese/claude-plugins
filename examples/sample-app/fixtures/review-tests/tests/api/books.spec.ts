import { test, expect } from "@playwright/test";

test("#0101 | lists books @api", async ({ request }) => {
	const res = await request.get("/api/books");
	expect(res.status()).toBe(200);
	const books = await res.json();
	expect(books.length).toBeGreaterThan(0);
	for (const b of books) expect(Object.keys(b)).toEqual(["id", "title", "author"]);
});

test("#0102 | adds a book @api", async ({ request }) => {
	const res = await request.post("/api/books", { data: { title: "A Made-Up Title", author: "Some Author" } });
	expect(res.status()).toBeLessThan(500);
});

test("#0103 | rejects a missing title @api", async ({ request }) => {
	const res = await request.post("/api/books", { data: { author: "Some Author" } });
	expect(res.status()).toBe(400);
	expect((await res.json()).errors).toContain("Title is required");
});

test("#0104 | removes a book @api", async ({ request }) => {
	const res = await request.delete("/api/books/1");
	expect(res.status()).toBe(204);
});
