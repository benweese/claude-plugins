/**
 * Test titles and tags.
 *
 * Every test title is built with {@link generateTestDescription}, so it carries a stable id and
 * its tags. The id is a number, unique across the whole test repo, shown as "#" plus at least
 * four digits (12 → "#0012"). It ties the test to its scenario in the plan
 * (`plans/<feature>.md`). Tags, not ids, say what kind of test it is.
 *
 * Run one test by its id: `npx playwright test --grep "#0012"`.
 *
 * @module testDescription
 */
/**
 * Tags for test titles. `@smoke`, `@api` and `@ui` select the Playwright project that runs a
 * test (see the test repo's `playwright.config.ts`); the others describe the test.
 */
export declare const TAGS: {
    /** Quick "is the site up" check; run after every deploy. */
    readonly SMOKE: "@smoke";
    /** Full functional coverage. */
    readonly REGRESSION: "@regression";
    /** API test. */
    readonly API: "@api";
    /** UI test in a browser. */
    readonly UI: "@ui";
    /** Accessibility check. */
    readonly A11Y: "@a11y";
    /** Slow test, left out of quick local runs. */
    readonly SLOW: "@slow";
};
/** One of the {@link TAGS} values, e.g. `"@smoke"`. */
export type Tag = (typeof TAGS)[keyof typeof TAGS];
/** Input for {@link generateTestDescription}. */
export interface TestDescription {
    /** The scenario's number from the plan, unique across the repo, e.g. `12` for #0012. */
    id: number;
    /** What the test checks, in plain words. */
    description: string;
    /** Values from {@link TAGS}. */
    tags?: readonly Tag[];
}
/**
 * Formats a test id for titles, plans and `--grep`. Padding to a fixed width means "#0012"
 * can never match "#00120" or "#0112".
 *
 * @param id - a positive whole number
 * @returns `"#"` plus at least four digits: `12` → `"#0012"`, `12345` → `"#12345"`
 * @throws Error if `id` is not a positive whole number
 */
export declare function formatTestId(id: number): string;
/**
 * Builds a test title from its id, description and tags.
 *
 * @param test - see {@link TestDescription}
 * @returns e.g. `"#0012 | shows the latest post first @ui @regression"`
 * @throws Error if `id` is not a positive whole number
 *
 * @example
 * test(generateTestDescription({ id: 12, description: "lists products", tags: [TAGS.API] }), async () => {
 * 	// ...
 * });
 */
export declare function generateTestDescription({ id, description, tags }: TestDescription): string;
