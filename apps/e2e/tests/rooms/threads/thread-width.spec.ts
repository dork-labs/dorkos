import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../../fixtures/rooms-api';

test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * The thread column keeps the width a reader chose from the KEYBOARD (DOR-2119).
 *
 * **Why this is a browser test.** Between the resize library's own keydown
 * listener on the separator and React's listener at the root, a real key press
 * runs the microtask queue — so React has already committed the new width
 * before the handler that saves it runs. jsdom's `fireEvent` and a
 * script-dispatched `KeyboardEvent` run both listeners back to back with no gap,
 * which is why a unit test once passed over a keyboard resize that was never
 * saved. Only a real key press, and a reload, can see that.
 *
 * No agent is in the room; every entry is the operator's, through the API.
 */
test.describe('Rooms — resizing a thread from the keyboard', () => {
  test('a width chosen with the arrow keys survives a reload', async ({ page, roomsApi }) => {
    const room = await roomsApi.createChannel(`e2e-thread-width-${roomsApi.runId}`);
    await roomsApi.postEntries(room.id, ['why is the build slow?']);
    const [rootEntryId] = await roomsApi.entryIds(room.id);
    await roomsApi.postThreadReply(room.id, rootEntryId!, 'the cache is cold');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/channels?id=${room.id}&thread=${rootEntryId}`);
    const panel = page.getByTestId('room-thread-panel');
    await expect(panel.getByTestId('room-entry')).toHaveCount(2, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    const width = async () => Math.round((await panel.boundingBox())!.width);
    const opened = await width();

    const handle = page.getByRole('separator', { name: 'Resize thread' });
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    // Left moves the line toward the room: the thread widens.
    await expect.poll(width).toBeGreaterThan(opened + 50);
    const chosen = await width();

    await page.reload();
    await expect(panel.getByTestId('room-entry')).toHaveCount(2, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect.poll(width).toBeGreaterThanOrEqual(chosen - 2);
    expect(await width()).toBeLessThanOrEqual(chosen + 2);
  });
});
