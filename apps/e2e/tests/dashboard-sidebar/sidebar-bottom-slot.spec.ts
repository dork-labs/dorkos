import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import type { RoomsApi } from '../../fixtures/rooms-api';

/**
 * The sidebar's bottom slot: pinned above the footer, one card, dismissible for
 * good (spec `sidebar-simplification` D4).
 *
 * **Only a browser can answer the first half of this.** The defect it exists to
 * catch is geometric: the promo card used to be the LAST CHILD of the scroller,
 * so a list longer than the panel pushed it below the fold and it was never seen
 * again. jsdom measures every element as 0×0, so a unit test can prove the card
 * is outside the scrolling element (`DashboardSidebar.test.tsx` does) but it
 * cannot prove the card is ON SCREEN with a list that overflows. That needs
 * layout, a viewport, and a real scroll.
 *
 * **And only a browser can answer the second half**, because "stays dismissed"
 * spans the whole stack: the × writes `ui.promos.dismissedIds` through
 * `PATCH /api/config`, and the proof is a reload reading it back off disk. That
 * is the difference the feature is for — the answer used to live in
 * `localStorage`, so it never left the browser it was given in.
 *
 * No agent turn is spent here: channels are the cheapest rows this suite can
 * make, and the card under test is a promo that qualifies on a fresh install.
 */

/** How tall the window is while the list is measured. */
const SHORT_VIEWPORT = { width: 1280, height: 620 };

/**
 * How many channels to seed.
 *
 * Enough that the Library list is taller than a 620px panel several times over,
 * so "the card is still visible" cannot pass by accident on a list that happens
 * to fit.
 */
const CHANNEL_COUNT = 25;

/** The slot container, which is in the DOM whether or not a card qualifies. */
function slot(page: Page) {
  return page.locator('[data-slot="sidebar-bottom-slot"]');
}

/** The promo card the slot draws on a fresh install. */
function promoCard(page: Page) {
  return page.locator('[data-slot="promo-card-compact"]');
}

/** The sidebar's scrolling element. */
function scroller(page: Page) {
  return page.locator('nav[aria-label="Sidebar"] [data-slot="sidebar-content"]');
}

/**
 * Seed enough channels that the Library list overflows a short panel.
 *
 * @param roomsApi - This run's seeder, which also puts the rooms away again.
 */
async function seedOverflowingList(roomsApi: RoomsApi): Promise<void> {
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    await roomsApi.createChannel(`e2e-slot-${roomsApi.runId}-${i}`);
  }
}

/**
 * Whether the element's box lies inside the viewport.
 *
 * @param page - The page under test.
 * @param selector - What to measure.
 */
async function isOnScreen(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return false;
    const box = el.getBoundingClientRect();
    if (box.height === 0) return false;
    return box.top >= 0 && box.bottom <= window.innerHeight;
  }, selector);
}

test.describe('the sidebar’s bottom slot @smoke', () => {
  // The spec dismisses a promo, which PATCHes `ui.promos.dismissedIds` to
  // `~/.dork/config.json` — a write that outlives this test. Fine for CI's
  // single run, but it made the spec impossible to `--repeat-each` to hunt
  // flakes: from run 3 on, the promo was already dismissed and "the card is
  // there at all" failed with "element(s) not found" (DOR-1584). Capture the
  // baseline here and restore it in `afterEach` so every run starts from the
  // same undismissed state the first one did.
  let dismissedIdsBefore: string[] = [];

  test.beforeEach(async ({ request }) => {
    const res = await request.get('/api/config');
    if (!res.ok()) return;
    // GET flattens this to `dismissedPromoIds` (`routes/config.ts`) — a
    // DIFFERENT shape than the PATCH body below, which writes the schema's
    // own nested `ui.promos.dismissedIds`.
    const config = (await res.json()) as { dismissedPromoIds: string[] };
    dismissedIdsBefore = config.dismissedPromoIds;
  });

  test.afterEach(async ({ request }) => {
    await request
      .patch('/api/config', { data: { ui: { promos: { dismissedIds: dismissedIdsBefore } } } })
      .catch(() => {});
  });

  test('stays on screen while the list scrolls, and stays dismissed after a reload', async ({
    page,
    roomsApi,
  }) => {
    await page.setViewportSize(SHORT_VIEWPORT);
    await seedOverflowingList(roomsApi);
    await page.goto('/');

    // ── The card is there at all, without anybody scrolling to find it ──
    // Both geometric reads poll for the same reason the overflow check below
    // does: the panel's boxes shift while the boot skeleton exits, and a
    // one-shot read can land mid-transition.
    await expect(promoCard(page)).toBeVisible();
    await expect.poll(() => isOnScreen(page, '[data-slot="promo-card-compact"]')).toBe(true);

    // The list really does overflow — otherwise everything below proves nothing.
    // Polled, not measured once: the bottom slot un-hides the moment the boot
    // gate opens, but `SidebarZones` holds the skeleton through a 160ms exit
    // under `AnimatePresence mode="wait"` — so for ~200ms the card is on screen
    // while the scroller still holds a skeleton that is sized to fit and cannot
    // overflow. A one-shot read in that window ejected two unrelated PRs from
    // the merge queue on 2026-08-26.
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight), {
        message: `seed ${CHANNEL_COUNT} channels into a ${SHORT_VIEWPORT.height}px window and the sidebar list must overflow`,
      })
      .toBeGreaterThan(100);

    // ── It does not move when the list does ──
    const before = await promoCard(page).boundingBox();
    await scroller(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const after = await promoCard(page).boundingBox();

    // Pinned: the card is a sibling of the scroller, so scrolling the list to
    // the bottom cannot move it by a pixel. With the card back inside the
    // scroller — the arrangement this replaced — it would be gone from the
    // viewport entirely by now.
    expect(after?.y).toBe(before?.y);
    await expect.poll(() => isOnScreen(page, '[data-slot="promo-card-compact"]')).toBe(true);

    // ── × takes THIS card away ──
    // Named rather than counted: the slot holds the highest-priority card that
    // still qualifies, so dismissing one hands the slot to the next — which is
    // the design, and would make a bare "no cards left" assertion fail for the
    // right behaviour.
    const dismissed = await promoCard(page).first().innerText();
    await page.getByRole('button', { name: 'Dismiss' }).first().click();
    await expect(page.getByText(dismissed.split('\n')[0]!, { exact: true })).toHaveCount(0);

    // Still one card at a time, never two.
    await expect.poll(() => promoCard(page).count()).toBeLessThanOrEqual(1);

    // ── And it is still gone after a reload ──
    // This is what config-backed dismissal buys: the answer survived a round
    // trip to `~/.dork/config.json` and back, rather than living in a browser
    // key this reload would also have carried.
    await page.reload();
    await expect(slot(page)).toHaveCount(1);
    await expect(page.getByText(dismissed.split('\n')[0]!, { exact: true })).toHaveCount(0);
  });
});
