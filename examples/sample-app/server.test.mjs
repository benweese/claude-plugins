// Smoke tests for the sample app (node --test). They prove the app the plugins test against works.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp, validateBook } from "./server.mjs";

let server;
let base;
before(async () => {
	server = createServer(createApp());
	await new Promise((resolve) => server.listen(0, resolve));
	base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test("GET / serves the page with a labelled form", async () => {
	const res = await fetch(`${base}/`);
	assert.equal(res.status, 200);
	const html = await res.text();
	assert.match(html, /<label for="title">Title<\/label>/);
	assert.match(html, /<html lang="en">/);
});

test("GET /api/books lists the seed books", async () => {
	const books = await (await fetch(`${base}/api/books`)).json();
	assert.equal(books.length, 3);
	assert.deepEqual(Object.keys(books[0]), ["id", "title", "author"]);
});

test("POST /api/books adds a book; GET and DELETE by id", async () => {
	const res = await fetch(`${base}/api/books`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: " New Title ", author: "A. Writer" }) });
	assert.equal(res.status, 201);
	const book = await res.json();
	assert.equal(book.title, "New Title");
	assert.equal((await fetch(`${base}/api/books/${book.id}`)).status, 200);
	assert.equal((await fetch(`${base}/api/books/${book.id}`, { method: "DELETE" })).status, 204);
	assert.equal((await fetch(`${base}/api/books/${book.id}`)).status, 404);
});

test("POST /api/books rejects missing fields, a long title and bad JSON", async () => {
	const post = (body) => fetch(`${base}/api/books`, { method: "POST", headers: { "content-type": "application/json" }, body });
	assert.deepEqual((await (await post("{}")).json()).errors, ["Title is required", "Author is required"]);
	assert.deepEqual(validateBook({ title: "x".repeat(121), author: "A" }).problems, ["Title must be 120 characters or fewer"]);
	assert.equal((await post("not json")).status, 400);
});

test("GET /a11y-broken serves the accessibility fixture", async () => {
	const res = await fetch(`${base}/a11y-broken`);
	assert.equal(res.status, 200);
	assert.match(await res.text(), /Broken on purpose/);
});

test("unknown routes and methods", async () => {
	assert.equal((await fetch(`${base}/nope`)).status, 404);
	assert.equal((await fetch(`${base}/api/books`, { method: "PUT" })).status, 405);
});

test("the component gallery and stories are served; nothing outside them", async () => {
	const { staticFile } = await import("./server.mjs");
	const page = await fetch(`${base}/playwright/gallery/index.html`);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /<main id="root">/);
	const story = await fetch(`${base}/src/components/BookList.story.js`);
	assert.equal(story.headers.get("content-type"), "text/javascript; charset=utf-8");
	assert.match(await story.text(), /export const LoadFailed/);
	assert.equal((await fetch(`${base}/src/components/Missing.js`)).status, 404);
	assert.equal(staticFile("/src/../server.mjs"), null);
	assert.equal(staticFile("/src/%2e%2e/server.mjs"), null);
	assert.equal(staticFile("/playwright/gallery/../../server.mjs"), null);
	assert.equal(staticFile("/fixtures/components/README.md"), null);
});
