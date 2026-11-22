// Types for a11y.js (keyboard, media and reflow checks). Owned by the qa plugin.
import type { Locator, Page } from "@playwright/test";

/** Asserts the given elements are reached by Tab in this relative order; others may sit in between. */
export declare function expectTabOrder(page: Page, locators: Locator[], options?: { maxTabs?: number }): Promise<void>;
/** Asserts the element shows a visible focus indicator when reached by keyboard (WCAG 2.4.7). */
export declare function expectVisibleFocus(page: Page, locator: Locator, options?: { maxTabs?: number }): Promise<void>;
/** Asserts focus is inside the open dialog and stays there through Tab and Shift+Tab. */
export declare function expectFocusTrapped(page: Page, dialog: Locator, options?: { presses?: number }): Promise<void>;
/** Asserts Escape closes the dialog and, with `opener`, that focus returns to it. */
export declare function expectEscapeCloses(page: Page, dialog: Locator, options?: { opener?: Locator }): Promise<void>;
/** Runs `fn` with emulated user preferences, then resets them. */
export declare function withMedia(
	page: Page,
	media: { reducedMotion?: "reduce" | "no-preference"; contrast?: "more" | "no-preference"; forcedColors?: "active" | "none"; colorScheme?: "light" | "dark" },
	fn: () => Promise<void>
): Promise<void>;
/** Reflow at 320px with 200% root text (an approximation); fails on sideways scrolling or clipped text; reports fixed font sizes. */
export declare function expectReflow(page: Page, options?: { width?: number; height?: number; fontScale?: number }): Promise<{ fixedFontSizes: string[] }>;
