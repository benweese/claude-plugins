// A tiny reading-list app the plugins test themselves against. No dependencies.
//
//   node examples/sample-app/server.mjs [port]      (default 4321, or PORT)
//
// Pages: /  (the list + an "Add a book" form).  API: GET /api/books, POST /api/books {title, author},
// GET /api/books/:id, DELETE /api/books/:id. Data is in memory and resets on restart. All data is made up.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = [
	{ id: 1, title: "The Quiet Lighthouse", author: "Mara Ellison" },
	{ id: 2, title: "Notes from a Small Orchard", author: "Theo Vance" },
	{ id: 3, title: "A Map of Borrowed Rooms", author: "Ines Kerrow" }
];

/** A fresh store (tests get their own). */
export function createStore() {
	let books = SEED.map((b) => ({ ...b }));
	let next = books.length + 1;
	return {
		list: () => books,
		get: (id) => books.find((b) => b.id === id),
		add: (title, author) => {
			const book = { id: next++, title, author };
			books.push(book);
			return book;
		},
		remove: (id) => {
			const before = books.length;
			books = books.filter((b) => b.id !== id);
			return books.length < before;
		}
	};
}

/** Problems with a new book, as plain messages (empty = valid). */
export function validateBook(body) {
	const problems = [];
	const title = typeof body?.title === "string" ? body.title.trim() : "";
	const author = typeof body?.author === "string" ? body.author.trim() : "";
	if (!title) problems.push("Title is required");
	else if (title.length > 120) problems.push("Title must be 120 characters or fewer");
	if (!author) problems.push("Author is required");
	return { problems, title, author };
}

function send(res, status, body, type = "application/json") {
	res.writeHead(status, { "content-type": type });
	res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function readJson(req) {
	let raw = "";
	for await (const chunk of req) raw += chunk;
	try {
		return raw ? JSON.parse(raw) : {};
	} catch {
		return null;
	}
}

/** The request handler (exported so tests can start their own server). */
export function createApp(store = createStore()) {
	return async (req, res) => {
		const url = new URL(req.url, "http://localhost");
		const match = /^\/api\/books(?:\/(\d+))?$/.exec(url.pathname);
		if (url.pathname === "/" && req.method === "GET") {
			return send(res, 200, await readFile(path.join(here, "public", "index.html"), "utf8"), "text/html; charset=utf-8");
		}
		if (!match) return send(res, 404, { error: "Not found" });
		const id = match[1] ? Number(match[1]) : null;
		if (id === null && req.method === "GET") return send(res, 200, store.list());
		if (id === null && req.method === "POST") {
			const body = await readJson(req);
			if (body === null) return send(res, 400, { errors: ["Body must be JSON"] });
			const { problems, title, author } = validateBook(body);
			if (problems.length) return send(res, 400, { errors: problems });
			return send(res, 201, store.add(title, author));
		}
		if (id !== null && req.method === "GET") {
			const book = store.get(id);
			return book ? send(res, 200, book) : send(res, 404, { error: "Book not found" });
		}
		if (id !== null && req.method === "DELETE") {
			return store.remove(id) ? send(res, 204, "", "text/plain") : send(res, 404, { error: "Book not found" });
		}
		return send(res, 405, { error: "Method not allowed" });
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const port = Number(process.argv[2] || process.env.PORT || 4321);
	createServer(createApp()).listen(port, () => console.log(`Sample app on http://localhost:${port}`));
}
