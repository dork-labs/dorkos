/**
 * Keep every browser test off Google Fonts (DOR-4871).
 *
 * The client's default font (`inter`) inserts a `fonts.googleapis.com`
 * stylesheet at startup, and `page.goto` waits for `load`, which waits for that
 * stylesheet. On Nov 20 Google stalled it for 19.6–45.2 s, page loads timed out
 * and the merge queue ejected PRs that had touched nothing near the spec that
 * failed. A browser test has no business depending on a third-party CDN.
 *
 * Two layers, because they cover different tests:
 *
 * - {@link FONT_FAMILY_KEY} = {@link E2E_FONT_FAMILY} is seeded by
 *   `playwright.config.ts` into every context's `storageState`, next to the
 *   boot-cache flag. The `system` pairing has no Google Fonts URL, so the client
 *   never asks for one. That reaches every spec in every project, including the
 *   ones that import `test` straight from `@playwright/test`.
 * - {@link stubGoogleFonts} answers whatever still asks (a test that picks a web
 *   font, `restoreDefaultTypography` after a reset) locally: an empty
 *   stylesheet for `fonts.googleapis.com`, an abort for `fonts.gstatic.com`. The
 *   shared `test` in `fixtures/index.ts` installs it on every context.
 *
 * Spelled here rather than imported from the client, for the reason
 * `boot-cache-flag.ts` gives: `apps/e2e` depends on no client code. The key is
 * pinned from the other side —
 * `apps/client/src/layers/shared/lib/__tests__/font-config.test.ts` asserts this
 * literal and names this file.
 *
 * @module google-fonts-stub
 */
import type { BrowserContext } from '@playwright/test';

/** See `STORAGE_KEYS.FONT_FAMILY` in `apps/client/src/layers/shared/lib/constants.ts`. */
export const FONT_FAMILY_KEY = 'dorkos-font-family';

/** The font pairing with no external stylesheet (`font-config.ts`, `googleFontsUrl: null`). */
export const E2E_FONT_FAMILY = 'system';

/** Google Fonts' stylesheet host — what `loadGoogleFont` inserts a `<link>` to. */
export const GOOGLE_FONTS_CSS = /^https:\/\/fonts\.googleapis\.com\//;

/** Google Fonts' font-file host — what those stylesheets point at. */
export const GOOGLE_FONTS_FILES = /^https:\/\/fonts\.gstatic\.com\//;

/**
 * Answer every Google Fonts request on this context without the network.
 *
 * Context-level so a popup or a second page of the same test is covered too.
 * No one-shot count option, on purpose: see GOTCHAS.md on one-shot
 * routes.
 *
 * @param context - The browser context to stub.
 */
export async function stubGoogleFonts(context: Pick<BrowserContext, 'route'>): Promise<void> {
  await context.route(GOOGLE_FONTS_CSS, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );
  await context.route(GOOGLE_FONTS_FILES, (route) => route.abort());
}
