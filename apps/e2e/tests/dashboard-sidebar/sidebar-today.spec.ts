import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS, type RoomsApi, type SeededRoom } from '../../fixtures/rooms-api';

/**
 * Today's anchor and its scroll-to-active guardrails, in a real browser (spec
 * `sidebar-now-today-library` BC-21, BC-36, P2 AC-3).
 *
 * **Only a browser can answer this.** Both behaviours are about scrolling and
 * about what a pointer is doing, and jsdom implements neither: it has no layout,
 * so nothing has a position to be scrolled to, and `scrollIntoView` does not
 * exist until a test invents it. The unit suite can prove the hook asked; only
 * this can prove the panel moved, once, and only when the operator switched
 * conversations.
 *
 * No agent turn is spent anywhere here. Today holds channels as readily as
 * sessions (BC-15), and a channel with one entry in it is the cheapest
 * conversation this suite can make.
 */

/** Where the init script records every `scrollIntoView` the page performs. */
interface ScrollRecord {
  /** Whether the scrolled element was Today's anchor. */
  anchor: boolean;
  /** The behaviour asked for — `'auto'` under reduced motion (BC-36). */
  behavior: string | undefined;
}

declare global {
  interface Window {
    /** Every scroll the page asked for since the recorder was installed. */
    __todayScrolls?: ScrollRecord[];
  }
}

/**
 * Record every `scrollIntoView` the page performs, before any of it runs.
 *
 * Patched rather than observed, because a scroll inside an already-short panel
 * moves nothing measurable — "did the panel move" would be false for a correct
 * implementation. What BC-36 is about is whether the panel ASKED, how many
 * times, and with what behaviour.
 *
 * @param page - The page to install it on, before the first navigation.
 */
async function recordScrolls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__todayScrolls = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function patched(
      this: Element,
      options?: boolean | ScrollIntoViewOptions
    ) {
      window.__todayScrolls?.push({
        anchor:
          this.getAttribute('aria-current') === 'page' &&
          this.closest('[data-sidebar-zone="today"]') !== null,
        behavior: typeof options === 'object' ? options.behavior : undefined,
      });
      original.call(this, options as ScrollIntoViewOptions);
    };
  });
}

/** Everything the page has scrolled so far. */
const scrolls = (page: Page) => page.evaluate(() => window.__todayScrolls ?? []);

/** Forget every scroll recorded so far. */
const clearScrolls = (page: Page) =>
  page.evaluate(() => {
    window.__todayScrolls = [];
  });

/**
 * A channel somebody has actually been in.
 *
 * The entry is not decoration: a room whose `lastActivityAt` still equals its
 * `createdAt` has no "back" to jump to and the recents rules drop it. Nobody is
 * in the room, so posting triggers no turn and costs nothing.
 *
 * @param roomsApi - This test's seeder, which also puts the room away again.
 * @param slug - The channel's slug, unique to this run.
 */
async function seedChannel(roomsApi: RoomsApi, slug: string): Promise<SeededRoom> {
  const room = await roomsApi.createChannel(slug);
  await roomsApi.postEntries(room.id, ['Where we left off.']);
  return room;
}

test.describe('Dashboard Sidebar — Today @smoke', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test('the conversation you have open is Today’s first row, on every switch', async ({
    page,
    basePage,
    dashboardSidebar,
    roomsApi,
  }) => {
    const first = `e2e-today-a-${roomsApi.runId}`;
    const second = `e2e-today-b-${roomsApi.runId}`;
    await seedChannel(roomsApi, first);
    await seedChannel(roomsApi, second);

    await recordScrolls(page);
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    // Nothing conversational is open on the home surface, so Today has no
    // anchor yet — which is what makes the two assertions below mean something.
    await expect(dashboardSidebar.rowWithText(first)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await dashboardSidebar.rowWithText(first).first().click();

    await expect(dashboardSidebar.todayAnchor).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(dashboardSidebar.todayAnchor).toContainText(first);
    await expect(dashboardSidebar.todayRows.first()).toContainText(first);

    await dashboardSidebar.rowWithText(second).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(second);
    // BC-21's whole point: the row that was first a moment ago is not first now,
    // and the one the operator opened is.
    await expect(dashboardSidebar.todayRows.first()).toContainText(second);
  });

  test('scrolls the anchor into view on a switch, and on nothing else', async ({
    page,
    basePage,
    dashboardSidebar,
    roomsApi,
  }) => {
    const first = `e2e-scroll-a-${roomsApi.runId}`;
    const second = `e2e-scroll-b-${roomsApi.runId}`;
    await seedChannel(roomsApi, first);
    const quiet = await seedChannel(roomsApi, second);

    await recordScrolls(page);
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await expect(dashboardSidebar.rowWithText(first)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await dashboardSidebar.rowWithText(first).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(first);
    await clearScrolls(page);

    // An unread change — a real model rebuild, and one the operator did not ask
    // for. The panel must not move under them.
    await roomsApi.postEntries(quiet.id, ['Something happened over here.']);
    await roomsApi.waitForUnread(quiet.id, 1);
    await expect(dashboardSidebar.rowWithText(second).first()).toBeVisible();
    expect(await scrolls(page), 'an unread badge is not a reason to move the panel').toEqual([]);

    // The paired half. Without it, "nothing scrolled" would also be true of a
    // sidebar that never scrolls at all.
    await dashboardSidebar.rowWithText(second).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(second);
    const after = await scrolls(page);
    expect(after.length, 'a conversation switch brings the anchor into view').toBe(1);
    expect(after[0]?.anchor).toBe(true);
    expect(after[0]?.behavior).toBe('smooth');
  });

  test('never opens a folded Library section to reach the same conversation', async ({
    page,
    basePage,
    dashboardSidebar,
    roomsApi,
  }) => {
    const first = `e2e-fold-a-${roomsApi.runId}`;
    const second = `e2e-fold-b-${roomsApi.runId}`;
    await seedChannel(roomsApi, first);
    await seedChannel(roomsApi, second);

    await recordScrolls(page);
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await expect(dashboardSidebar.rowWithText(first)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await dashboardSidebar.rowWithText(first).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(first);

    // Fold Channels away. Both conversations still have a Today row; only their
    // Library copies are hidden (BC-33).
    const channels = dashboardSidebar.librarySectionToggle('Channels');
    await expect(channels).toHaveAttribute('aria-expanded', 'true');
    await channels.click();
    await expect(channels).toHaveAttribute('aria-expanded', 'false');
    await clearScrolls(page);

    await dashboardSidebar.todayRows.filter({ hasText: second }).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(second);
    expect((await scrolls(page)).length, 'the switch still brings the anchor over').toBe(1);
    await expect(channels, 'scrolling opened a section the operator folded').toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});

test.describe('Dashboard Sidebar — Today under reduced motion @smoke', () => {
  test.describe.configure({ timeout: 120_000 });

  test('jumps to the anchor instead of travelling to it', async ({
    page,
    basePage,
    dashboardSidebar,
    roomsApi,
  }) => {
    const first = `e2e-motion-a-${roomsApi.runId}`;
    const second = `e2e-motion-b-${roomsApi.runId}`;
    await seedChannel(roomsApi, first);
    await seedChannel(roomsApi, second);

    // The preference, set on the CONTEXT rather than through `test.use` — the
    // fixture object this suite extends does not carry Playwright's own
    // options, so the emulation is applied directly.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await recordScrolls(page);
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await expect(dashboardSidebar.rowWithText(first)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await dashboardSidebar.rowWithText(first).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(first);
    await clearScrolls(page);

    await dashboardSidebar.rowWithText(second).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(second);
    const after = await scrolls(page);
    expect(after.length).toBe(1);
    // The row still comes into view; it just does not travel there.
    expect(after[0]?.behavior).toBe('auto');
  });
});
