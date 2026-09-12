import { randomUUID } from 'node:crypto';
import { test, expect } from '../../fixtures';
import { RightPanelPage } from '../../pages/RightPanelPage';

/**
 * One session, two windows, one canvas (spec `canvas-agent-seat` §1).
 *
 * This is the promise the whole phase exists to keep, and it is the one thing
 * jsdom cannot prove: a document opened in one browser context appearing in
 * ANOTHER, live, with no reload — and still being there after a reload. Before
 * this landed the canvas was one browser's `localStorage`, so a second window on
 * the same session showed nothing at all, and the failure was silent.
 *
 * It found a real one on the way in: the `canvas` frame reached the socket and
 * the second window ignored it, because the client dispatches frames by NAME and
 * the name was not on `SESSION_EVENT_TYPES`. The unit pin in
 * `stream-manager.test.ts` covers that seam; this covers the whole path.
 *
 * Driven the way a person does it — the right panel's Canvas tab, its empty
 * state, its tab strip — and never by seeding rows: a test that wrote to the
 * database would prove the database works and say nothing about whether a
 * window ever hears.
 *
 * The CANVAS tab rather than the Browser one, deliberately: what is being proved
 * is that the TABLE is shared, and the Browser view's starting point frames a
 * real site, which would put a network round trip inside an assertion about a
 * database row.
 */

/** The tab an empty Canvas view's "Markdown" action opens. */
const DOCUMENT_TAB = /^Document$/;

test.describe('The session canvas is the same in every window @smoke', () => {
  // Two browser contexts, four navigations and a reload: comfortably past the
  // 30-second default, and none of it is waiting on one slow step.
  test.slow();

  test('a document opened in one window appears in the other, live, and survives a reload', async ({
    page,
    rightPanel,
    browser,
  }) => {
    const sessionId = randomUUID();

    // --- Window one: put a page on this session's canvas. ------------------
    await rightPanel.goto(`/session?session=${sessionId}`);
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await page.getByRole('button', { name: /^Markdown/ }).click();
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible();

    // --- Window two: a SEPARATE context, so nothing is shared. -------------
    // Not a second tab of the same context: `localStorage` is per origin, and a
    // second tab would have shared it — which is exactly what this must not be
    // able to lean on. Everything window two knows came off the session's own
    // stream.
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    try {
      // The same page object window one uses: opening the panel is a retry
      // loop, not one click — below desktop width it is a sheet that mounts
      // nothing until it is open, and the per-agent layout restore can shut it
      // again mid-wait.
      const secondPanel = new RightPanelPage(secondPage);
      await secondPanel.goto(`/session?session=${sessionId}`);
      await secondPanel.ensureTabStripOpen();
      await secondPanel.canvasTab.click();
      // Straight off the cold snapshot — no reload, no second click.
      await expect(secondPage.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible({
        timeout: 20_000,
      });

      // --- A reload of window one still has it. ----------------------------
      await page.reload();
      await rightPanel.ensureTabStripOpen();
      await rightPanel.canvasTab.click();
      await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible({ timeout: 20_000 });

      // --- A close in one window is a close in the other, live. ------------
      // The close control is a SIBLING of the tab, not a child of it (a button
      // inside a button is invalid HTML), so it is addressed by its own label.
      await page.getByRole('button', { name: /^Close Document/i }).click();
      await expect(secondPage.getByRole('tab', { name: DOCUMENT_TAB })).toHaveCount(0, {
        timeout: 20_000,
      });
    } finally {
      await second.close();
    }
  });
});
