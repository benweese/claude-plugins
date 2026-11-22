// Stories for BookList: one export per state (Playwright's story-gallery model). Each story returns a DOM node.
// Where the component takes callbacks, the story owns the state and records it in a hidden form for tests to read.
import { BookList } from "./BookList.js";

const BOOKS = [
	{ id: 1, title: "The Quiet Lighthouse", author: "Mara Ellison" },
	{ id: 2, title: "Notes from a Small Orchard", author: "Theo Vance" }
];

/** A hidden form input that records a value for the test (`getByTestId(id)` → `toHaveValue`). */
function recorder(testId, value) {
	const form = document.createElement("form");
	form.hidden = true;
	const input = document.createElement("input");
	input.dataset.testid = testId;
	input.readOnly = true;
	input.value = value;
	form.append(input);
	return { form, set: (v) => (input.value = v) };
}

/** Books listed; Remove records the removed ids. */
export const Default = (props = {}) => {
	const removed = [];
	const rec = recorder("removed", "[]");
	const frag = document.createDocumentFragment();
	frag.append(BookList({ books: BOOKS, ...props, onRemove: (id) => { removed.push(id); rec.set(JSON.stringify(removed)); } }), rec.form);
	return frag;
};

export const Empty = () => BookList({ books: [] });

export const Loading = () => BookList({ state: "loading" });

/** The load failed; Try again records how many times it was pressed. */
export const LoadFailed = (props = {}) => {
	let retries = 0;
	const rec = recorder("retries", "0");
	const frag = document.createDocumentFragment();
	frag.append(BookList({ state: "error", ...props, onRetry: () => rec.set(String(++retries)) }), rec.form);
	return frag;
};

export const Disabled = () => BookList({ books: BOOKS, disabled: true });
