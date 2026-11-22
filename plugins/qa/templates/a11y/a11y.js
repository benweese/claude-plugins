// Keyboard, media and reflow checks for Playwright accessibility tests. Owned by the qa plugin (not commons).
// Axe scans come from playwright-test-commons' expectNoA11yViolations (or its copied `ui` bundle).
import { expect, test } from "@playwright/test";

const activeIs = (locator) => locator.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false);

/**
 * Asserts the given elements are reached by Tab in this relative order (e.g. email → password → submit).
 * Other focusable elements may sit in between; the page's full tab sequence isn't checked.
 * Starts from the top of the page.
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator[]} locators in the order they should be reached
 * @param {{ maxTabs?: number }} [options] how many Tab presses to try (default 60)
 */
export async function expectTabOrder(page, locators, { maxTabs = 60 } = {}) {
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		window.getSelection()?.removeAllRanges();
	});
	await page.locator("body").focus().catch(() => {});
	const reached = new Array(locators.length).fill(-1);
	for (let press = 1; press <= maxTabs && reached.includes(-1); press++) {
		await page.keyboard.press("Tab");
		for (let i = 0; i < locators.length; i++) if (reached[i] === -1 && (await activeIs(locators[i]))) reached[i] = press;
	}
	const missing = reached.map((r, i) => (r === -1 ? i : null)).filter((i) => i !== null);
	expect(missing, `not reachable with Tab (within ${maxTabs} presses): element(s) #${missing.map((i) => i + 1).join(", #")}`).toEqual([]);
	const outOfOrder = reached.findIndex((r, i) => i > 0 && r < reached[i - 1]);
	expect(outOfOrder, `tab order: element #${outOfOrder + 1} is reached before element #${outOfOrder} (presses: ${reached.join(", ")})`).toBe(-1);
}

/**
 * Asserts an element shows a visible focus indicator when reached by keyboard: its outline, box-shadow or border
 * differs from the unfocused state (WCAG 2.4.7).
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} locator
 * @param {{ maxTabs?: number }} [options]
 */
export async function expectVisibleFocus(page, locator, { maxTabs = 60 } = {}) {
	const look = () => locator.evaluate((el) => {
		const s = getComputedStyle(el);
		return { outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` : "none", shadow: s.boxShadow, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`, bg: s.backgroundColor };
	});
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	const before = await look();
	let focused = false;
	for (let i = 0; i < maxTabs && !focused; i++) {
		await page.keyboard.press("Tab");
		focused = await activeIs(locator);
	}
	expect(focused, "the element can't be reached with Tab").toBe(true);
	const after = await look();
	const changed = after.outline !== "none" || after.shadow !== before.shadow || after.border !== before.border || after.bg !== before.bg;
	expect(changed, `no visible focus indicator (outline: ${after.outline}, box-shadow unchanged, border unchanged)`).toBe(true);
}

/**
 * Asserts focus is inside an open dialog and stays there through Tab and Shift+Tab (WCAG 2.4.3, 2.1.2).
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} dialog the open dialog
 * @param {{ presses?: number }} [options] Tab presses each way (default: focusable elements + 2)
 */
export async function expectFocusTrapped(page, dialog, { presses } = {}) {
	await expect(dialog).toBeVisible();
	// "in" = inside the dialog, "none" = nothing on the page (a native modal <dialog> lets Tab visit the browser's own
	// toolbar, then comes back — allowed), "out" = another element on the page (the trap is broken).
	const where = () => dialog.evaluate((d) => {
		const a = document.activeElement;
		if (a && d.contains(a)) return "in";
		return !a || a === document.body || a === document.documentElement ? "none" : `out: <${a.tagName.toLowerCase()}>${a.id ? `#${a.id}` : ""} "${(a.textContent || a.getAttribute("aria-label") || "").trim().slice(0, 30)}"`;
	});
	expect(await where(), "focus didn't move into the dialog when it opened").toBe("in");
	const n = presses ?? (await dialog.locator("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])").count()) + 2;
	for (const key of ["Tab", "Shift+Tab"]) {
		let outside = 0;
		for (let i = 1; i <= n; i++) {
			await page.keyboard.press(key);
			const w = await where();
			expect(w.startsWith("out"), `focus left the dialog after ${i} × ${key} (${w})`).toBe(false);
			outside = w === "none" ? outside + 1 : 0;
			expect(outside, `focus left the dialog after ${i} × ${key} and didn't come back`).toBeLessThan(2);
		}
	}
}

/**
 * Asserts Escape closes the dialog and, if `opener` is given, focus returns to it (WCAG 2.1.2, 2.4.3).
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} dialog
 * @param {{ opener?: import("@playwright/test").Locator }} [options]
 */
export async function expectEscapeCloses(page, dialog, { opener } = {}) {
	await page.keyboard.press("Escape");
	await expect(dialog, "Escape didn't close the dialog").toBeHidden();
	if (opener) expect(await activeIs(opener), "focus didn't return to the button that opened the dialog").toBe(true);
}

/**
 * Runs `fn` with emulated user preferences, then resets them.
 * @param {import("@playwright/test").Page} page
 * @param {{ reducedMotion?: "reduce" | "no-preference", contrast?: "more" | "no-preference", forcedColors?: "active" | "none", colorScheme?: "light" | "dark" }} media
 * @param {() => Promise<void>} fn
 */
export async function withMedia(page, media, fn) {
	await page.emulateMedia(media);
	try {
		await fn();
	} finally {
		await page.emulateMedia({ reducedMotion: null, contrast: null, forcedColors: null, colorScheme: null });
	}
}

/**
 * Reflow and text size, approximated: 320 CSS px wide (WCAG 1.4.10) with the root font at 200% (1.4.4 — the OS text
 * setting can't be emulated). Fails on horizontal overflow or clipped text and attaches a screenshot. Text that
 * doesn't grow with the root (fixed px font sizes) can't be caught by root scaling, so it's reported as a finding
 * (a test annotation and the return value), not a failure.
 * @param {import("@playwright/test").Page} page
 * @param {{ width?: number, height?: number, fontScale?: number }} [options]
 * @returns {Promise<{ fixedFontSizes: string[] }>}
 */
export async function expectReflow(page, { width = 320, height = 640, fontScale = 2 } = {}) {
	const original = page.viewportSize();
	const sizes = () => page.evaluate(() => Array.from(document.querySelectorAll("body *")).filter((el) => el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())).map((el) => parseFloat(getComputedStyle(el).fontSize)));
	const describe = () => page.evaluate(() => Array.from(document.querySelectorAll("body *")).filter((el) => el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())).map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""} "${el.textContent.trim().slice(0, 40)}"`));
	const before = await sizes();
	await page.setViewportSize({ width, height });
	await page.addStyleTag({ content: `html { font-size: ${fontScale * 100}% !important; }` });
	const after = await sizes();
	const names = await describe();
	const fixedFontSizes = names.filter((_, i) => before[i] && after[i] && after[i] < before[i] * fontScale * 0.9);
	const problems = await page.evaluate(() => {
		const out = [];
		const de = document.documentElement;
		if (de.scrollWidth > de.clientWidth + 1) {
			const name = (el) => `<${el.tagName.toLowerCase()}>${el.id ? `#${el.id}` : ""} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}"`;
			// An element past the edge, or one whose content (a word that can't wrap) spills out of its own box.
			const wide = Array.from(document.querySelectorAll("body *")).filter((el) => el.getClientRects().length && (el.getBoundingClientRect().right > de.clientWidth + 1 || el.scrollWidth > el.clientWidth + 1));
			const deepest = wide.filter((el) => !wide.some((o) => o !== el && el.contains(o))).slice(0, 5);
			out.push(`the page scrolls sideways (${de.scrollWidth}px wide in ${de.clientWidth}px); too wide: ${deepest.map((el) => `${name(el)} to ${Math.round(el.getBoundingClientRect().right)}px`).join(", ")}`);
		}
		for (const el of document.querySelectorAll("body *")) {
			const s = getComputedStyle(el);
			if (!el.textContent.trim() || !el.getClientRects().length) continue;
			const clips = s.overflowX !== "visible" || s.textOverflow === "ellipsis";
			if (clips && el.scrollWidth > el.clientWidth + 1) out.push(`clipped text: <${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 40)}"`);
		}
		return out;
	});
	let info = null;
	try {
		info = test.info();
	} catch {
		/* not inside a Playwright test */
	}
	if (info) {
		await info.attach(`reflow-${width}px-${fontScale * 100}pct`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
		for (const f of fixedFontSizes) info.annotations.push({ type: "a11y-finding", description: `fixed font size (doesn't grow with the root): ${f}` });
	}
	if (original) await page.setViewportSize(original);
	expect(problems, `reflow at ${width}px with ${fontScale * 100}% text (an approximation of the OS text setting)`).toEqual([]);
	return { fixedFontSizes };
}
