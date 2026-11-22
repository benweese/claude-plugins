/**
 * Accessibility scans with axe-core. Needs `@axe-core/playwright` installed in the test repo
 * (an optional peer dependency); it is loaded only when a scan runs.
 *
 * @module accessibility
 */
import { expect } from "@playwright/test";
/** The axe rule tags for WCAG 2.0, 2.1 and 2.2 at levels A and AA. The default for every scan. */
export const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/**
 * Runs axe-core over the whole page as it is now.
 *
 * @param page - the page to scan
 * @param options - see {@link A11yOptions}
 * @returns the violations; empty when the page passes
 * @throws Error if `@axe-core/playwright` isn't installed
 *
 * @example
 * const violations = await scanA11y(page, { tags: ["wcag2a"] });
 */
export async function scanA11y(page, { tags = WCAG_AA_TAGS, exclude = [] } = {}) {
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    let builder = new AxeBuilder({ page }).withTags([...tags]);
    for (const selector of exclude) {
        builder = builder.exclude(selector);
    }
    const results = await builder.analyze();
    return results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        help: violation.help,
        targets: violation.nodes.map((node) => node.target.join(" "))
    }));
}
/**
 * Scans the page with axe-core and asserts (soft) that it has no violations. Each violation is
 * reported as one line: the rule, its impact, how many elements it hit and the first few of them.
 *
 * @param page - the page to scan, after it has loaded the state to check
 * @param options - see {@link A11yOptions}
 * @throws Error if `@axe-core/playwright` isn't installed
 *
 * @example
 * await home.open();
 * await expectNoA11yViolations(page);
 */
export async function expectNoA11yViolations(page, options = {}) {
    const { maxTargetsShown = 4 } = options;
    const violations = await scanA11y(page, options);
    const summary = violations.map(({ id, impact, targets }) => {
        const shown = targets.slice(0, maxTargetsShown).join(" | ");
        const more = targets.length > maxTargetsShown ? ` | and ${targets.length - maxTargetsShown} more` : "";
        return `${id} (${impact ?? "no impact"}) on ${targets.length} element(s): ${shown}${more}`;
    });
    expect.soft(summary, `axe violations on ${page.url()}`).toEqual([]);
}
