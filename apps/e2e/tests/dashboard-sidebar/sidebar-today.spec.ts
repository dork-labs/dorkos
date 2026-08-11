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

/**
 * What a thread row prints after its `›`.
 *
 * A thread's row shows the ROOT it hangs off (`ThreadSummary.rootPreview`), not
 * its newest reply — so this is the root's own words, and it is deliberately
 * unlike anything else this suite posts.
 */
const THREAD_ROOT_TEXT = 'The message this thread hangs off.';

/**
 * A channel with a thread hanging off its first entry.
 *
 * The threaded case is what makes the "exactly one anchor" assertions
 * discriminate: a thread row and its channel row carry the same `roomId`, so a
 * sidebar that compared ids rather than row keys lights both — and the count-1
 * check below passes trivially on a channel that has no thread.
 *
 * @param roomsApi - This test's seeder, which also puts the room away again.
 * @param slug - The channel's slug, unique to this run.
 */
async function seedThreadedChannel(
  roomsApi: RoomsApi,
  slug: string
): Promise<{ room: SeededRoom; rootEntryId: string }> {
  const room = await roomsApi.createChannel(slug);
  await roomsApi.postEntries(room.id, [THREAD_ROOT_TEXT]);
  const [rootEntryId] = await roomsApi.entryIds(room.id);
  if (rootEntryId === undefined) throw new Error(`${slug} stored no entry to hang a thread off`);
  await roomsApi.postThreadReply(room.id, rootEntryId, 'And here is a reply under it.');
  return { room, rootEntryId };
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

  test('lights the thread you opened, not the channel it lives in', async ({
    basePage,
    dashboardSidebar,
    roomsApi,
  }) => {
    const slug = `e2e-today-thread-${roomsApi.runId}`;
    await seedThreadedChannel(roomsApi, slug);

    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await expect(dashboardSidebar.rowWithText(slug)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await dashboardSidebar.rowWithText(slug).first().click();

    // Both rows are on screen now — the channel, and the thread inside it.
    const threadRow = dashboardSidebar.todayRows.filter({ hasText: THREAD_ROOT_TEXT });
    await expect(threadRow).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    // The CHANNEL is what is open, so the channel is the one that is lit.
    await expect(dashboardSidebar.todayAnchor).toHaveCount(1);
    await expect(dashboardSidebar.todayAnchor).not.toContainText(THREAD_ROOT_TEXT);

    // Open the thread. It is a different place, so the tint and the anchor move
    // to it — and `aria-current="page"` stays unique, which is the handle
    // scroll-to-active finds the anchor by.
    await threadRow.first().click();
    await expect(dashboardSidebar.todayAnchor).toHaveCount(1);
    await expect(dashboardSidebar.todayAnchor).toContainText(THREAD_ROOT_TEXT);
    await expect(dashboardSidebar.todayRows.first()).toContainText(THREAD_ROOT_TEXT);
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
    // for. The panel must not move under them. Two, not one: `seedChannel`'s own
    // entry is already unread, so this is the second.
    await roomsApi.postEntries(quiet.id, ['Something happened over here.']);
    await roomsApi.waitForUnread(quiet.id, 2);
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
    // BOTH opened, so both have a Today row of their own. Today's membership is
    // "conversations you have been in" (BC-15), and a channel the operator has
    // never opened lives only in Library — folding that away would leave nothing
    // to click and the case would time out rather than assert anything.
    await dashboardSidebar.rowWithText(first).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(first);
    await dashboardSidebar.rowWithText(second).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(second);

    // Fold Channels away. Both conversations still have a Today row; only their
    // Library copies are hidden (BC-33).
    const channels = dashboardSidebar.librarySectionToggle('Channels');
    await expect(channels).toHaveAttribute('aria-expanded', 'true');
    await channels.click();
    await expect(channels).toHaveAttribute('aria-expanded', 'false');
    await clearScrolls(page);

    await dashboardSidebar.todayRows.filter({ hasText: first }).first().click();
    await expect(dashboardSidebar.todayAnchor).toContainText(first);
    expect((await scrolls(page)).length, 'the switch still brings the anchor over').toBe(1);
    await expect(channels, 'scrolling opened a section the operator folded').toHaveAttribute(
      'aria-expanded',
      'false'
    );

    // Put it back. The fold is server-held prefs on a server this whole suite
    // shares, so leaving Channels folded hides every channel row from whatever
    // runs next — which is how the reduced-motion case below failed for a
    // reason that had nothing to do with it.
    await channels.click();
    await expect(channels).toHaveAttribute('aria-expanded', 'true');
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
