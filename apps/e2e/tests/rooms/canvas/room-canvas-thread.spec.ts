import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../../fixtures/rooms-api';
import { RoomsPage } from '../../../pages/RoomsPage';
import { BasePage } from '../../../pages/BasePage';

/**
 * Talking about one document on a room's canvas (spec `canvas-agent-seat` §7).
 *
 * **What only a browser can show here** is that the button, the room's log and
 * the thread panel are one flow: pressing Discuss writes a line naming the
 * document, the panel opens on it, and pressing Discuss a second time lands in
 * the same conversation rather than starting a second one. The server's half —
 * the entry and the column landing in one transaction — is pinned in
 * `room-canvas-thread.test.ts`, where the database is reachable.
 *
 * **Why this lives under `tests/rooms/canvas/`** rather than at
 * `tests/rooms/`: that directory is already routed to the test-mode leg, where
 * a room turn is scripted and free. Nothing here un-silences an agent, but a
 * test that asserts "nobody was woken" belongs on the leg where being wrong
 * about that costs nothing.
 */

/** Put a document on a room's canvas as the person, through the app's own route. */
async function putOnCanvas(
  request: APIRequestContext,
  roomId: string,
  title: string
): Promise<string> {
  const res = await request.post(`/api/rooms/${roomId}/canvas`, {
    data: { content: { type: 'markdown', title, content: `# ${title}` } },
  });
  if (!res.ok()) throw new Error(`Could not put ${title} on the canvas: ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

/** Open a room and wait until its masthead is really on screen. */
async function openRoom(
  page: import('@playwright/test').Page,
  basePage: BasePage,
  roomsPage: RoomsPage,
  roomId: string
): Promise<void> {
  await page.goto(`/channels?id=${roomId}`);
  await basePage.waitForAppReady();
  await expect(roomsPage.roomHeader).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('A document on a room’s canvas has its own discussion', () => {
  test('Discuss opens a thread naming the document, and a second Discuss lands in it', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
  }, testInfo) => {
    const tag = roomsApi.runId;
    const room = await roomsApi.createChannel(`thread-${tag}`, `Thread ${tag}`, []);
    const title = `The plan ${tag}`;
    await putOnCanvas(request, room.id, title);

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsPage.openCanvasTab();
    await expect(roomsPage.canvasDocuments).toContainText(title, {
      timeout: SERVER_ROUND_TRIP_MS,
    });

    await page.getByRole('button', { name: 'Discuss' }).click();

    // The panel opens on the thread, and its root names the document.
    await expect(roomsPage.threadPanel).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.threadEntries.first()).toContainText(title);
    await testInfo.attach('discuss-opened-the-thread', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });

    // Exactly one line about it in the room, not one per press.
    const rootId = (await roomsApi.entryIds(room.id)).at(-1);
    expect(rootId).toBeDefined();

    await page.getByRole('button', { name: 'Discuss' }).click();
    await expect(roomsPage.threadPanel).toBeVisible();
    // Nothing new was written, and the panel is still on the same root.
    await page.waitForTimeout(500);
    expect(await roomsApi.entryIds(room.id)).toHaveLength(1);
    await expect(roomsPage.threadEntries.first()).toContainText(title);
  });

  test('a reply in a document’s thread starts nobody’s turn', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
  }) => {
    const tag = roomsApi.runId;
    const name = `Planner${tag}`;
    const agent = await roomsApi.registerAgent(name, '🗺️', '#0891b2');
    const room = await roomsApi.createChannel(`thread-quiet-${tag}`, `Quiet ${tag}`, [agent]);
    const title = `The diff ${tag}`;
    await putOnCanvas(request, room.id, title);

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsPage.openCanvasTab();
    await expect(roomsPage.canvasDocuments).toContainText(title, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await page.getByRole('button', { name: 'Discuss' }).click();
    await expect(roomsPage.threadPanel).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    const rootId = (await roomsApi.entryIds(room.id))[0];
    await roomsApi.postThreadReply(room.id, rootId, `this column looks wrong ${tag}`);

    // Two entries — the root and the reply — and nothing else, for long enough
    // that a turn would have landed if one had been asked for.
    await expect
      .poll(async () => (await roomsApi.entryIds(room.id)).length, {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toBe(2);
    await page.waitForTimeout(2_000);
    expect(await roomsApi.entryIds(room.id)).toHaveLength(2);
  });
});
