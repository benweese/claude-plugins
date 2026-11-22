/**
 * Base class for page objects.
 *
 * UI tests use three layers per page:
 * - `tests/ui/locators/<name>Locators.ts`: a factory, `(page: Page) => ({ ...locators })`
 * - `tests/ui/pages/<Name>Page.ts`: extends BasePage, one method per user action
 * - `tests/ui/specs/<name>.spec.ts`: calls page methods and asserts, with no raw locators
 *
 * @module BasePage
 */
import { type Locator, type Page, type Response } from "@playwright/test";
/**
 * Builds a page's locators.
 *
 * @example
 * export const homeLocators = (page: Page) => ({
 * 	searchBox: page.getByRole("searchbox", { name: "Search" })
 * });
 */
export type LocatorFactory<L> = (page: Page) => L;
/** Options for the checks on {@link BasePage}. */
export interface ExpectOptions {
    /** Soft (the test continues on failure) by default. Pass `false` when later steps depend on the check. */
    soft?: boolean;
    /** How long to wait, in milliseconds. Defaults to the project's `expect.timeout`. Raise it only for something known to be slow. */
    timeout?: number;
}
/** A browser dialog (alert, confirm, prompt or beforeunload) the page opened. */
export interface DialogInfo {
    /** `"alert"`, `"confirm"`, `"prompt"` or `"beforeunload"`. */
    type: string;
    /** The dialog's text. */
    message: string;
}
/** What to do with a dialog: accept it (OK) or dismiss it (Cancel). */
export type DialogAction = "accept" | "dismiss";
/**
 * Base class for page objects. Page methods call these helpers (`this.click`, `this.fill`, ...)
 * rather than raw Playwright, so waits stay consistent. Add a helper here only when every page
 * could use it and it takes locators as arguments; anything with page-specific names belongs on
 * the page object.
 *
 * @template L - the page's locators, usually `ReturnType<typeof homeLocators>`
 *
 * @example
 * export class LoginPage extends BasePage<LoginLocators> {
 * 	constructor(page: Page) {
 * 		super(page, loginLocators);
 * 	}
 *
 * 	async login(email: string, password: string) {
 * 		await this.fill(this.locators.emailInput, email);
 * 		await this.fill(this.locators.passwordInput, password);
 * 		await this.click(this.locators.loginButton);
 * 	}
 * }
 */
export declare class BasePage<L extends object = Record<string, Locator>> {
    /** The Playwright page this object drives. */
    readonly page: Page;
    /** The page's locators, built by the factory passed to the constructor. */
    readonly locators: L;
    /**
     * @param page - the Playwright page
     * @param locatorFactory - builds the page's locators; omit for a page with none
     */
    constructor(page: Page, locatorFactory?: LocatorFactory<L>);
    /**
     * Navigates to a path relative to the project's `baseURL`. Waits for `domcontentloaded`, not
     * `load`: a stalled third-party script (ads, analytics) can hold back the load event
     * indefinitely, and web-first assertions wait for the elements a test needs anyway.
     *
     * @param path - e.g. `"/login"`. Default `"/"`
     * @returns the main resource response, or null (see Playwright's `page.goto`)
     */
    goto(path?: string): Promise<Response | null>;
    /**
     * Waits for an element to be visible, then clicks it.
     *
     * @param locator - the element to click
     */
    click(locator: Locator): Promise<void>;
    /**
     * Waits for a field to be editable, then replaces its value.
     *
     * @param locator - the input, textarea or editable element
     * @param value - the text to enter; numbers are converted to text
     */
    fill(locator: Locator, value: string | number): Promise<void>;
    /**
     * Selects a dropdown option by its visible label.
     *
     * @param locator - the `<select>` element
     * @param label - the option's visible text
     */
    selectOption(locator: Locator, label: string): Promise<void>;
    /**
     * Waits for an element to be visible and returns its text.
     *
     * @param locator - the element to read
     * @returns the element's visible text, trimmed
     */
    getText(locator: Locator): Promise<string>;
    /**
     * Returns the text of every element a locator matches. Does not wait: use it after the
     * elements are known to be on the page.
     *
     * @param locator - matches zero or more elements
     * @returns each element's visible text, trimmed
     */
    getAllTexts(locator: Locator): Promise<string[]>;
    /**
     * Asserts an element is visible.
     *
     * @param locator - the element to check
     * @param message - shown if the check fails
     * @param options - soft by default, so one run reports every failed check; see {@link ExpectOptions}
     */
    expectVisible(locator: Locator, message?: string, { soft, timeout }?: ExpectOptions): Promise<void>;
    /**
     * Asserts an element is hidden or not on the page.
     *
     * @param locator - the element to check
     * @param message - shown if the check fails
     * @param options - soft by default; see {@link ExpectOptions}
     */
    expectHidden(locator: Locator, message?: string, { soft, timeout }?: ExpectOptions): Promise<void>;
    /**
     * Asserts how many elements a locator matches.
     *
     * @param locator - matches zero or more elements
     * @param count - the expected number; `0` checks that none are on the page
     * @param message - shown if the check fails
     * @param options - soft by default; see {@link ExpectOptions}
     */
    expectCount(locator: Locator, count: number, message?: string, { soft, timeout }?: ExpectOptions): Promise<void>;
    /**
     * Asserts a locator matches at least one element, e.g. that a results list isn't empty.
     *
     * @param locator - matches zero or more elements
     * @param message - shown if the check fails
     * @param options - soft by default; see {@link ExpectOptions}
     */
    expectAny(locator: Locator, message?: string, { soft, timeout }?: ExpectOptions): Promise<void>;
    /**
     * Asserts a form control's current value.
     *
     * @param locator - the input, textarea or select
     * @param value - the expected value; `""` for an empty field
     * @param message - shown if the check fails
     * @param options - soft by default; see {@link ExpectOptions}
     */
    expectValue(locator: Locator, value: string | RegExp, message?: string, { soft, timeout }?: ExpectOptions): Promise<void>;
    /**
     * Asserts a form control fails the browser's own validation (`required`, `type="email"`, ...),
     * i.e. its `validationMessage` is not empty. The wording differs per browser and language, so
     * it is never compared.
     *
     * @param locator - the input, select or textarea
     * @param message - shown if the check fails
     * @param options - soft by default; see {@link ExpectOptions}
     */
    expectInvalid(locator: Locator, message?: string, { soft, timeout }?: ExpectOptions): Promise<void>;
    /**
     * Asserts the names of the files chosen in a file input.
     *
     * @param locator - the `<input type="file">`
     * @param names - the expected file names, in order; `[]` for none
     * @param message - shown if the check fails
     */
    expectFilesAttached(locator: Locator, names: string[], message?: string): Promise<void>;
    /**
     * Asserts (soft) the page's title.
     *
     * @param title - the full title, or a pattern
     */
    expectTitle(title: string | RegExp): Promise<void>;
    /**
     * Reloads the page. Waits for `domcontentloaded`, like {@link BasePage.goto}.
     *
     * @returns the main resource response, or null (see Playwright's `page.reload`)
     */
    reload(): Promise<Response | null>;
    /**
     * Waits for the page's `load` event. {@link BasePage.goto} only waits for `domcontentloaded`, so
     * use this before acting on a control whose handler is bound by a script at the end of the
     * page: until that script runs, the control is visible but a click does nothing.
     */
    waitForLoad(): Promise<void>;
    /**
     * Clicks an element and waits for the response it triggers, for actions whose only visible
     * result comes after a request (an item removed, a list refreshed).
     *
     * @param locator - the element to click
     * @param url - the response to wait for: a URL, a pattern, or a predicate
     * @returns the response
     *
     * @example
     * await this.clickAndWaitForResponse(this.locators.removeButton(name), (r) => r.url().endsWith(`/delete_cart/${id}`));
     */
    clickAndWaitForResponse(locator: Locator, url: string | RegExp | ((response: Response) => boolean | Promise<boolean>)): Promise<Response>;
    /**
     * Chooses files in a file input.
     *
     * @param locator - the `<input type="file">`
     * @param files - one path or several; `[]` clears the input
     */
    uploadFiles(locator: Locator, files: string | string[]): Promise<void>;
    /**
     * Clicks an element that opens a browser dialog, answers the dialog and returns what it said.
     * If no dialog opens, it waits for the project's `actionTimeout`, or the test timeout when no
     * `actionTimeout` is set (Playwright's default), then fails.
     *
     * @param locator - the element to click
     * @param action - accept (OK) or dismiss (Cancel). Default `"accept"`
     * @param promptText - the text to enter when accepting a prompt
     * @returns the dialog's type and message
     *
     * @example
     * const dialog = await this.clickAndHandleDialog(this.locators.submitButton, "dismiss");
     */
    clickAndHandleDialog(locator: Locator, action?: DialogAction, promptText?: string): Promise<DialogInfo>;
    /**
     * From now on, dismisses every dialog the page opens and records its message, for checking
     * later that none opened. Without a listener Playwright dismisses dialogs silently, so they
     * would go unnoticed.
     *
     * @returns a list that fills as dialogs open; assert it is empty when no dialog was expected
     */
    recordDialogs(): string[];
    /**
     * Asserts (soft) an element's text.
     *
     * @param locator - the element, or elements, to check
     * @param text - the expected text; an array checks each matched element in order
     */
    expectText(locator: Locator, text: string | RegExp | ReadonlyArray<string | RegExp>): Promise<void>;
    /**
     * Asserts (soft) the page's URL.
     *
     * @param pattern - the full URL, or a pattern such as `/[?&]q=shoes/`
     */
    expectUrl(pattern: string | RegExp): Promise<void>;
    /**
     * The current query string, for checking URL state after a search or filter.
     *
     * @returns e.g. `{ q: "shoes", page: "2" }`
     */
    searchParams(): Record<string, string>;
}
