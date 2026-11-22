import { test, expect } from "@playwright/test";

// Planted scope creep: a user journey written as a component test. It leaves the gallery for the real app, uses the
// real API and covers two goals (add a book, then remove it). That's an e2e test; review-tests should flag it.

test("#0205 | adds a book then removes it @component", async ({ mount, page }) => {
	await mount("BookList/Default");
	await page.goto("/");
	await page.getByLabel("Title").fill("A Made-Up Title");
	await page.getByLabel("Author").fill("Some Author");
	await page.getByRole("button", { name: "Add book" }).click();
	await expect(page.getByRole("alert")).toHaveText("Added “A Made-Up Title”.");
	await page.getByRole("button", { name: "Remove A Made-Up Title" }).click();
	await expect(page.getByRole("button", { name: "Remove A Made-Up Title" })).toHaveCount(0);
});
