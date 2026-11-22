import { test, expect } from "@playwright/test";

// Component tests for BookList (stories: src/components/BookList.story.js). Planted gap: the LoadFailed story is
// never mounted, so the error state (alert + "Try again") is untested.

test("#0201 | lists the books and records a removal @component", async ({ mount }) => {
	const list = await mount("components/BookList/Default");
	await expect(list.getByRole("listitem")).toHaveCount(2);
	await list.getByRole("button", { name: "Remove The Quiet Lighthouse" }).click();
	await expect(list.getByTestId("removed")).toHaveValue("[1]");
});

test("#0202 | shows the empty message @component", async ({ mount }) => {
	const list = await mount("BookList/Empty");
	await expect(list.getByText("No books yet. Add one to get started.")).toBeVisible();
	await expect(list.getByRole("list")).toHaveCount(0);
});

test("#0203 | announces loading @component", async ({ mount }) => {
	const list = await mount("BookList/Loading");
	await expect(list.getByRole("status")).toHaveText("Loading books…");
	await expect(list.getByRole("region", { name: "Books" })).toHaveAttribute("aria-busy", "true");
});

test("#0204 | disables Remove @component", async ({ mount }) => {
	const list = await mount("BookList/Disabled");
	for (const b of await list.getByRole("button", { name: /^Remove / }).all()) await expect(b).toBeDisabled();
});
