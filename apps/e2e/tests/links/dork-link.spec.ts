import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';

// One server, one room list, like every spec in this folder.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * A `/r/<dork-uri>` link opens the thing it names (DOR-5046), end to end: the
 * app's `/r/$` route asks the real server (`GET /api/links/target`) and
 * replaces itself with the screen that shows it. The unit tests pin each kind
 * against a mock transport; this proves the real route, the real capability
 * and the real room meet.
 *
 * Rooms rather than a chat because a room and its messages are seeded over
 * HTTP with no model; a chat link takes the same route and the same request.
 */
test.describe('A dork: link opens what it names', () => {
  test('a room link opens the room, and a message link lands on the message', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-dork-link-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug);
    const said = `the link should land here ${roomsApi.runId}`;
    await roomsApi.postEntries(room.id, [said]);
    const entry = (await roomsApi.listEntries(room.id)).find((e) => e.body.text === said);
    if (!entry) throw new Error('the seeded message did not land in the room');

    await page.goto(`/r/dork:room:${room.id}`);
    await expect(page).toHaveURL(new RegExp(`/channels\\?id=${room.id}$`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await basePage.waitForAppReady();
    await expect(roomsPage.entry(said)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    await page.goto(`/r/dork:entry:${entry.id}`);
    await expect(page).toHaveURL(new RegExp(`/channels\\?id=${room.id}&entry=${entry.seq}$`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.entry(said)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
  });

  test('a link to nothing shows the ordinary not-found page and stays put', async ({ page }) => {
    await page.goto('/r/dork:room:01JD3G5W7X9Y2Z4A6B8C0D1EZZ');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(page).toHaveURL(/\/r\/dork:room:01JD3G5W7X9Y2Z4A6B8C0D1EZZ$/);
  });
});
