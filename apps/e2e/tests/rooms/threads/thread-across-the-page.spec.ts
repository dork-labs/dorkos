import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../../fixtures/rooms-api';

// Same shape as its siblings: one cockpit at a time, and a ceiling sized for a
// machine already running several worktrees of agents. Higher than the usual
// 90s because this spec's whole point is a room too big for one page, and
// seeding sixty-one entries through the real routes is most of its runtime.
test.describe.configure({ mode: 'default', timeout: 180_000 });

/**
 * A thread stays a thread when its root is older than the page (DOR-690).
 *
 * **What only a browser can answer here** is what the reader is actually shown
 * once the room has more history than one request returns. The page size is a
 * server constant, the grouping is a client function, and each is pinned in its
 * own unit test — but "does a busy room read as a conversation or as a wall of
 * unattributed lines" is a question about the two of them meeting over HTTP,
 * and until this spec existed nothing asked it.
 *
 * The room below is the ticket's own reproduction, scaled to what a browser
 * test can seed in a minute: one message and sixty answers to it, so the
 * fifty-entry page the cockpit loads is ALL replies and the root is nowhere in
 * it. A smaller room cannot fail — the root would be in the page either way —
 * so it would certify nothing about this at all.
 *
 * No agent is in the room and nothing here can start a turn: every entry is
 * written by the operator through the API.
 */
test.describe('Rooms — a thread whose root is older than the loaded page', () => {
  test('reads as one thread, not as a page of unattached replies', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-deep-thread-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['why is the build slow?']);
    const [rootEntryId] = await roomsApi.entryIds(room.id);
    for (let i = 0; i < 60; i++) {
      await roomsApi.postThreadReply(room.id, rootEntryId!, `answer ${i}`);
    }

    await page.goto(`/channels?id=${room.id}`);

    // ONE message in the room's flow: the root, fetched back from outside the
    // page because the page pointed at it. Before the fix this was fifty rows —
    // every reply drawn as a fresh remark, with nothing on any of them saying
    // it answered anything.
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.entries.first()).toContainText('why is the build slow?');

    // Read off the accessibility tree rather than a test id: the way into a
    // thread is a button, and what it promises is what its accessible name
    // says. SIXTY is the room's own count, carried back on the root — this
    // client holds fifty of them, and a row counting what it loaded would
    // disagree with the Threads list about the same thread.
    const threadRow = page.getByRole('button', { name: /^↳?\s*60 replies · last/ });
    await expect(threadRow).toBeVisible();
    await expect(threadRow).toHaveAttribute('aria-expanded', 'false');

    // And nothing is stranded: the marker a reply wears when the timeline
    // cannot place it is the de-threaded state this fixes, so its absence is
    // the assertion.
    await expect(page.getByTestId('room-entry-orphan')).toHaveCount(0);

    // The way in still works, and the panel opens on the real thread rather
    // than on its "the message this thread hangs off is not loaded" notice —
    // which is precisely what a reader used to get here.
    await threadRow.click();
    await expect(roomsPage.threadPanel).toBeVisible();
    await expect(roomsPage.threadOrphan).toHaveCount(0);

    // And the feed does not number itself: `-1` is the APG's "I do not know",
    // which is the honest answer over the tail of a sixty-one message thread
    // this client holds fifty-one of. Asked of `aria-setsize` rather than by
    // counting elements because that is exactly what a screen reader is told —
    // and "51 of 51" here would be the same lie the row above just stopped
    // telling.
    await expect(roomsPage.threadEntries.first()).toHaveAttribute('aria-setsize', '-1');
  });
});
