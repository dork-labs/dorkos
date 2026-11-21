/**
 * The `test` every browser spec builds on: Playwright's own, with Google Fonts
 * answered locally on every context (DOR-4871, see `google-fonts-stub.ts`).
 *
 * Nothing else lives here, so a spec that wants Playwright's bare `test` (no
 * page objects, no automatic sidebar lock from `fixtures/index.ts`) imports
 * this one instead of `@playwright/test` and changes nothing but the fonts.
 * `fixtures/index.ts` extends it.
 *
 * Overriding the built-in `context` is what puts the stub under every page,
 * popup and `page.goto` of a test. A context a spec makes itself with
 * `browser.newContext()` is not covered; `playwright.config.ts` makes its
 * Google Fonts requests fail fast instead.
 *
 * @module fixtures/base
 */
import { test as playwrightTest } from '@playwright/test';
import { stubGoogleFonts } from '../google-fonts-stub';

export const test = playwrightTest.extend({
  context: async ({ context }, use) => {
    await stubGoogleFonts(context);
    await use(context);
  },
});
