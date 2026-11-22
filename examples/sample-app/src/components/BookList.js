// A framework-free component: renders the reading list in one of its states. Returns a DOM element.
//   BookList({ books, state = "ready", error, disabled, onRemove, onRetry })
//   state: "ready" (books, or the empty message when there are none) | "loading" | "error"
// Used by the component-testing fixture (playwright/gallery + BookList.story.js). All data is made up.

/** @param {{ books?: {id: number, title: string, author: string}[], state?: "ready" | "loading" | "error", error?: string, disabled?: boolean, onRemove?: (id: number) => void, onRetry?: () => void }} props */
export function BookList({ books = [], state = "ready", error = "Couldn't load the books.", disabled = false, onRemove = () => {}, onRetry = () => {} } = {}) {
	const section = document.createElement("section");
	section.setAttribute("aria-labelledby", "book-list-title");
	section.setAttribute("aria-busy", String(state === "loading"));
	const h = document.createElement("h2");
	h.id = "book-list-title";
	h.textContent = "Books";
	section.append(h);

	if (state === "loading") {
		const p = document.createElement("p");
		p.setAttribute("role", "status");
		p.textContent = "Loading books…";
		section.append(p);
		return section;
	}
	if (state === "error") {
		const p = document.createElement("p");
		p.setAttribute("role", "alert");
		p.textContent = error;
		const retry = document.createElement("button");
		retry.type = "button";
		retry.textContent = "Try again";
		retry.onclick = () => onRetry();
		section.append(p, retry);
		return section;
	}
	if (!books.length) {
		const p = document.createElement("p");
		p.textContent = "No books yet. Add one to get started.";
		section.append(p);
		return section;
	}
	const ul = document.createElement("ul");
	for (const b of books) {
		const li = document.createElement("li");
		li.append(`${b.title} — ${b.author} `);
		const del = document.createElement("button");
		del.type = "button";
		del.textContent = "Remove";
		del.setAttribute("aria-label", `Remove ${b.title}`);
		del.disabled = disabled;
		del.onclick = () => onRemove(b.id);
		li.append(del);
		ul.append(li);
	}
	section.append(ul);
	return section;
}
