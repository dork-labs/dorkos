import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../../fixtures/rooms-api';

// One cockpit at a time, and a ceiling sized for a machine already running
// several worktrees of agents. Nothing here starts an agent turn: every entry is
// written by the operator through the API, into a room with no agent in it.
test.describe.configure({ mode: 'default', timeout: 120_000 });

/**
 * The Threads page: every thread you are in, across rooms, newest reply first,
 * each one answerable where it stands (DOR-3078).
 *
 * The sidebar lists places and never threads, so this page is where a thread is
 * found. What only a browser can answer: that the card draws the room's real
 * messages from the room's real history, that a reply typed on the card
 * reaches the thread on the server, and that the card's room opens the thread
 * beside its room.
 */
test.describe('Threads page', () => {
  test('lists a thread you are in, answers it in place, and opens it in its room', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-threads-page-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, [`Which logo do we ship? ${roomsApi.runId}`]);
    const [rootEntryId] = await roomsApi.entryIds(room.id);
    for (const text of ['the round one', 'the square one', 'the round one, again']) {
      await roomsApi.postThreadReply(room.id, rootEntryId!, text);
    }

    // Reached the way a person reaches it: the sidebar's own door.
    await page.goto('/');
    const threadsDoor = page
      .locator('[data-sidebar-section="top"]')
      .getByRole('button', { name: 'Threads', exact: true });
    await threadsDoor.click();
    await expect(page).toHaveURL(/\/threads$/);
    await expect(threadsDoor).toHaveAttribute('aria-current', 'page');

    const card = page.getByTestId('thread-card').filter({ hasText: `#${slug}` });
    await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // The root, the two newest replies, and what is not drawn, said as a count.
    await expect(card).toContainText(`Which logo do we ship? ${roomsApi.runId}`);
    await expect(card).toContainText('the square one');
    await expect(card).toContainText('the round one, again');
    await expect(card.getByTestId('thread-card-more')).toHaveText('1 more reply');

    // Answered where it stands, through the room's own composer.
    const answer = `ship the round one ${roomsApi.runId}`;
    await card.getByTestId('thread-card-reply').click();
    const box = card.getByRole('combobox');
    await expect(box).toBeFocused();
    await box.fill(answer);
    await box.press('Enter');
    await expect
      .poll(
        async () =>
          (await roomsApi.listEntries(room.id)).some(
            (entry) =>
              entry.body?.text === answer &&
              (entry as { threadRootEntryId?: string | null }).threadRootEntryId === rootEntryId
          ),
        { timeout: SERVER_ROUND_TRIP_MS }
      )
      .toBe(true);
    await expect(card).toContainText(answer, { timeout: SERVER_ROUND_TRIP_MS });

    // The room's name opens the thread beside its room.
    await card.getByRole('button', { name: `#${slug}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/channels\\?.*id=${room.id}`));
    await expect(roomsPage.threadPanel).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.threadPanel).toContainText(answer);
  });

  test('says so in plain words when there is no thread to show', async ({ page }) => {
    // The list is the server's, and this leg is shared — so the empty state is
    // asked of a page whose thread read answers nothing, rather than of a
    // server that may hold another spec's threads.
    await page.route(
      (url) => url.pathname === '/api/rooms/threads',
      (route) => route.fulfill({ json: { threads: [] } })
    );
    await page.goto('/threads');
    await expect(page.getByText('No threads yet')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
  });
});
