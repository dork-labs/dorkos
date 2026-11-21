/**
 * Keep every browser test off Google Fonts (DOR-4871).
 *
 * Until DOR-4872, the client's default font (`inter`) inserted a
 * `fonts.googleapis.com` stylesheet at startup, and `page.goto` waits for
 * `load`, which waited for that stylesheet. On Nov 20 Google stalled it for
 * 19.6–45.2 s, page loads timed out and the merge queue ejected PRs that had
 * touched nothing near the spec that failed. A browser test has no business
 * depending on a third-party CDN.
 *
 * The default pairing (Inter + JetBrains Mono) now ships with the client
 * (`apps/client/src/bundled-fonts.css`), so a start asks Google for nothing and
 * text keeps the real fonts' metrics. Only a font a person picks in Settings
 * still loads from Google. {@link stubGoogleFonts} fails those closed, without
 * the network: any stylesheet gets an empty one, any font file is aborted.
 * Nothing is passed through.
 *
 * The first version of this fix seeded the `system` font instead. That changed
 * line widths, and run 44831381307 failed two layout-sensitive specs on it
 * (`sidebar-model-showcase.spec.ts:197`, `file-tree-open.spec.ts:49`).
 *
 * Installed on every context by `fixtures/base.ts`. As a backstop for contexts
 * no fixture reaches (`browser.newContext()` in a spec), `playwright.config.ts`
 * passes Chromium {@link GOOGLE_FONTS_HOST_RULES}, which makes both hosts fail
 * to resolve at once, so an unrouted request errors instead of stalling.
 *
 * @module google-fonts-stub
 */
import type { BrowserContext } from '@playwright/test';

/** Google Fonts' stylesheet host — what `loadGoogleFont` inserts a `<link>` to. */
export const GOOGLE_FONTS_CSS = /^https:\/\/fonts\.googleapis\.com\//;

/** Google Fonts' font-file host — what those stylesheets point at. */
export const GOOGLE_FONTS_FILES = /^https:\/\/fonts\.gstatic\.com\//;

/**
 * Chromium switch that makes both Google Fonts hosts fail DNS immediately.
 * Routed requests never reach DNS, so it only affects requests nothing routed.
 */
export const GOOGLE_FONTS_HOST_RULES =
  '--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND';

/**
 * Answer every Google Fonts request on this context without the network: an
 * empty stylesheet, or an aborted font file.
 *
 * Context-level so a popup or a second page of the same test is covered too.
 * No one-shot count option, on purpose: see GOTCHAS.md on one-shot routes.
 *
 * @param context - The browser context to stub.
 */
export async function stubGoogleFonts(context: Pick<BrowserContext, 'route'>): Promise<void> {
  await context.route(GOOGLE_FONTS_CSS, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );
  await context.route(GOOGLE_FONTS_FILES, (route) => route.abort());
}
