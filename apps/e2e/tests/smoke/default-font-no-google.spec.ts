import { test, expect } from '../../fixtures';
import { GOOGLE_FONTS_CSS, GOOGLE_FONTS_FILES } from '../../google-fonts-stub';

/**
 * A start on the default font never waits on Google (DOR-4872).
 *
 * The default pairing (Inter + JetBrains Mono) ships with the app
 * (`apps/client/src/bundled-fonts.css`). Before that, the client added a Google
 * Fonts stylesheet at startup, the page's `load` event waited for it, and a
 * stalled Google held every start: 19 to 45 s in CI on Nov 20.
 *
 * The suite's stub answers Google Fonts locally for every spec
 * (`google-fonts-stub.ts`, DOR-4871). This one overrides it so Google hangs
 * rather than answers, the worst case: a start that still asked would never
 * fire `load`, and the test would time out. No tighter deadline than the
 * test's own, since a cold start alone can take over 10 s. It checks the
 * shell comes up, nothing reached Google, and Inter came from the app itself.
 */

test.describe('the default font at start @smoke', () => {
  test.beforeEach(async ({ context }) => {
    // Registered after the fixture's stub, so it wins: Google never answers.
    await context.route(GOOGLE_FONTS_CSS, () => {});
    await context.route(GOOGLE_FONTS_FILES, () => {});
  });

  test('reaches the app shell with Google unreachable, and draws Inter from the app', async ({
    page,
    basePage,
  }) => {
    const google: string[] = [];
    const bundled: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (GOOGLE_FONTS_CSS.test(url) || GOOGLE_FONTS_FILES.test(url)) google.push(url);
      if (/inter-[a-z-]+-wght-normal[^/]*\.woff2/.test(url)) bundled.push(url);
    });

    await page.goto('/', { waitUntil: 'load' });
    await basePage.waitForAppReady();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();

    // The default is what the app started on.
    const sans = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-sans')
    );
    expect(sans).toContain("'Inter'");

    // Inter itself is drawn, from the app's own files. A loaded face, not
    // `document.fonts.check`, which also says yes when no Inter is declared.
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.fonts].some(
            (face) => face.family.replace(/["']/g, '') === 'Inter' && face.status === 'loaded'
          )
        )
      )
      .toBe(true);
    expect(bundled.length).toBeGreaterThan(0);
    for (const url of bundled) expect(new URL(url).origin).toBe(new URL(page.url()).origin);

    expect(google).toEqual([]);
  });
});
