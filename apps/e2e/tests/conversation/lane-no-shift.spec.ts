import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { publishPresence, tapRoomStream } from '../rooms/room-signals';

// Same shape as its siblings in `tests/rooms`: one cockpit at a time, and a
// ceiling sized for a machine already running several worktrees of agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * The live lane fills in, and the page does not move.
 *
 * **This is the browser-only claim of the whole phase.** jsdom reports every
 * element as 0 × 0, so nothing in a unit test can see the one property the lane
 * exists for: it is a fixed 24 pixels whether or not it has anything to say, so
 * an agent picking something up cannot push the message you were reading.
 *
 * The line it replaced was absent when nobody was working and present when
 * somebody was — which meant that in a room you had scrolled back through, an
 * agent starting work moved the history under your eyes.
 *
 * The room, its history and its live stream are all real; only the presence
 * signal is the test's, injected into the real stream (`room-signals.ts` says
 * why, and what that does and does not prove).
 */
test.describe('Conversation — the live lane never moves the page', () => {
  test('a room scrolled back to the middle stays exactly where it was when an agent picks something up', async ({
    page,
    roomsApi,
    roomsPage,
    request,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const slug = `e2e-lane-shift-${roomsApi.runId}`;
    // Silenced by the fixture, so nothing here can start a real turn.
    const room = await roomsApi.createChannel(slug, slug, [ana]);
    // Enough history that the room genuinely scrolls: the claim is about a
    // reader who has scrolled BACK, which a room of three messages cannot have.
    await roomsApi.postEntries(
      room.id,
      Array.from({ length: 40 }, (_, index) => `message ${index + 1} in the backlog`)
    );

    const roster = await roomsApi.getRoom(room.id);
    const anaAuthorId = roster.members.find((member) => member.author.kind === 'agent')!.author.id;
    const entries = await request.get(`/api/rooms/${room.id}/entries`);
    const { entries: stored } = (await entries.json()) as { entries: { id: string }[] };
    const triggerId = stored[0]!.id;

    await tapRoomStream(page);
    await page.goto(`/channels?id=${room.id}`);
    // The list is virtualized, so it never holds all forty at once — see
    // `RoomsPage.waitForHistory`.
    await roomsPage.waitForHistory(40, SERVER_ROUND_TRIP_MS);

    // The lane is already there, holding its 24 pixels open with nothing in it.
    // That is the whole mechanism: the space is reserved before it is needed.
    const lane = page.locator('[data-slot="live-lane"]');
    await expect(lane).toBeAttached();
    expect(await lane.evaluate((node) => Math.round(node.getBoundingClientRect().height))).toBe(24);
    await expect(roomsPage.presenceLine).toHaveCount(0);

    // Scroll back to the middle of the history and settle there.
    await roomsPage.scroller.evaluate((node) => {
      node.scrollTop = Math.round(node.scrollHeight / 2);
    });
    await page.waitForTimeout(300);

    const before = await measure(page);
    // A reader who has scrolled back is by definition not at the bottom — a
    // measurement taken at the pin would prove nothing, because the pin puts the
    // scroller back wherever it lands.
    expect(before.scrollTop).toBeGreaterThan(0);

    await publishPresence(page, {
      authorId: anaAuthorId,
      state: 'working',
      entryId: triggerId,
      since: new Date().toISOString(),
    });

    // The line fills in…
    await expect(roomsPage.presenceLine).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.presenceLine).toContainText('is working on it');

    // …and nothing moved. Both halves matter: `scrollTop` alone would pass if
    // the content above the viewport grew, and the row's box alone would pass if
    // the scroller compensated.
    const after = await measure(page);
    expect(after.scrollTop).toBe(before.scrollTop);
    expect(after.firstRowTop).toBe(before.firstRowTop);
    expect(after.laneHeight).toBe(24);
  });
});

/** What the page looks like, in the two numbers a shift would move. */
async function measure(page: import('@playwright/test').Page): Promise<{
  scrollTop: number;
  firstRowTop: number;
  laneHeight: number;
}> {
  return page.evaluate(() => {
    const timeline = document.querySelector('[data-testid="room-timeline"]')!;
    const scroller = timeline.parentElement!;
    const row = document.querySelector('[data-testid="room-entry"]')!;
    const lane = document.querySelector('[data-slot="live-lane"]')!;
    return {
      scrollTop: Math.round(scroller.scrollTop),
      firstRowTop: Math.round(row.getBoundingClientRect().top),
      laneHeight: Math.round(lane.getBoundingClientRect().height),
    };
  });
}
