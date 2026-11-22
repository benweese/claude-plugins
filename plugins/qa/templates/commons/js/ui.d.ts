// Entry for the ui bundle, split from @benweese/playwright-test-commons' index.d.ts.
export { BasePage } from "./ui/BasePage.js";
export type { LocatorFactory, ExpectOptions, DialogInfo, DialogAction } from "./ui/BasePage.js";
export { WCAG_AA_TAGS, scanA11y, expectNoA11yViolations } from "./ui/accessibility.js";
export type { A11yOptions, A11yViolation } from "./ui/accessibility.js";
