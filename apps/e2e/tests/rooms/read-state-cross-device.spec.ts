import { test, expect } from '../../fixtures';
import { BasePage } from '../../pages/BasePage';
import { RoomsPage } from '../../pages/RoomsPage';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from './open-cockpit';

// Not `fullyParallel`, and given a longer budget, for the reason
// `room-identity.spec.ts` states: these tests share one server and one room
// list, and each of them loads TWO cockpits rather than one. They stay
// independent (`default`, not `serial`) — each seeds its own room.
test.describe.configure({ mode: 'default', timeout: 120_000 });

/**
 * Read state follows the reader between devices (spec `team-room-home` §D4,
 * ADR 260808-140956).
 *
 * The promise is small to say and impossible to test anywhere but here: read a
 * conversation on your laptop and its unread badge goes out on your phone,
 * straight away, without anybody refreshing anything. Every layer under this is
 * unit-tested — the store's monotonic write, the route's delegation into the
 * rooms domain, the broadcast, the client's patch of the room list — and all of
 * them can be green while the badge on the second screen stays lit, because
 * what joins them is a live SSE connection held by a browser this process does
 * not own.
 *
 * **Two contexts, not two pages in one.** A context is the honest stand-in for
 * a second device: its own storage, its own cookies, its own sockets. Two pages
 * of one context would share a profile, which is exactly the thing the old
 * per-browser watermark got wrong and this table exists to fix — a test that
 * shared it could pass against a cursor that never left the browser.
 *
 * **What makes the assertion mean something.** The room list is not polled:
 * there is no `refetchInterval` anywhere in `entities/room`, and the second
 * cockpit issues no mutation of its own. So the only thing that can take that
 * badge down is the `read_cursor` frame arriving on its global event stream. If
 * the broadcast is removed, nothing else clears it and this goes red — which is
 * the check being provable, not merely present.
 *
 * No Claude SDK or API key: rooms are seeded over REST and nothing here starts
 * an agent turn.
 */
test.describe('Read state — one mark, every device @smoke', () => {
  test('reading a room on one device takes its badge down on the other', async ({
    browser,
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-xdev-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug);
    // Three entries nobody has read. Three is the number asserted below, not
    // "some" — a badge that reads a different count is a different bug.
    await roomsApi.postEntries(room.id, ['first', 'second', 'third']);
    // The badge comes off the room LIST, which lags the entry write. Waiting
    // here keeps a slow projection from being reported as a missing badge.
    await roomsApi.waitForUnread(room.id, 3);

    // Device one: the fixture's own page.
    await openCockpit(basePage);
    const rowA = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
    await expect(rowA).toHaveAccessibleName(`#${slug} 3 unread`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // Device two: a second context, opened AFTER the room exists so its first
    // read of the room list already holds it (see `openCockpit`).
    const secondDevice = await browser.newContext();
    try {
      const pageB = await secondDevice.newPage();
      const roomsPageB = new RoomsPage(pageB);
      await openCockpit(new BasePage(pageB));

      const rowB = roomsPageB.rowIn(roomsPageB.channels, `#${slug}`);
      // Both screens agree it is unread before anybody reads it. Asserting this
      // is what stops the test passing on a second cockpit that never rendered
      // the room at all — "no badge" would otherwise be indistinguishable from
      // "no row".
      await expect(rowB).toHaveAccessibleName(`#${slug} 3 unread`, {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // Read it on device one. Opening the room is what moves the cursor.
      await rowA.click();
      await expect(page).toHaveURL(new RegExp(`/channels\\?.*id=${room.id}`), {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(roomsPage.entries).toHaveCount(3, { timeout: SERVER_ROUND_TRIP_MS });
      await expect(rowA).toHaveAccessibleName(`#${slug}`);

      // And device two puts its badge away, having been told. Deliberately no
      // `pageB.reload()` between the click and this line: a reload would prove
      // only that the server stored the cursor, which the route tests already
      // say. What is on trial here is the live path.
      await expect(rowB).toHaveAccessibleName(`#${slug}`, { timeout: SERVER_ROUND_TRIP_MS });
    } finally {
      await secondDevice.close();
    }
  });

  test('the mark is where the second device left it, after a reload', async ({
    browser,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    // The other half of "one mark": durability. The test above proves the badge
    // moves live; this one proves the thing it moved to is stored per PERSON
    // and not per browser — a fresh context, which has never seen this room and
    // holds no storage of its own, must open already knowing it is read.
    //
    // Together they close the pair the old per-browser watermark failed: it was
    // live within a tab and lost between them.
    const slug = `e2e-xdev-cold-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug);
    await roomsApi.postEntries(room.id, ['first', 'second']);
    await roomsApi.waitForUnread(room.id, 2);

    await openCockpit(basePage);
    const rowA = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
    await expect(rowA).toHaveAccessibleName(`#${slug} 2 unread`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await rowA.click();
    // Waiting on the SERVER's count rather than on the badge: this test is
    // about what a later reader is told, so the write has to have landed before
    // that reader loads. Asserting the badge would leave the second cockpit
    // racing the cursor write.
    await roomsApi.waitForUnread(room.id, 0);

    const laterDevice = await browser.newContext();
    try {
      const pageB = await laterDevice.newPage();
      const roomsPageB = new RoomsPage(pageB);
      await openCockpit(new BasePage(pageB));

      const rowB = roomsPageB.rowIn(roomsPageB.channels, `#${slug}`);
      await expect(rowB).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      // Cold, from storage this browser has never written to: no badge, and the
      // name said once.
      await expect(rowB).toHaveAccessibleName(`#${slug}`);
    } finally {
      await laterDevice.close();
    }
  });
});
