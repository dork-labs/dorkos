import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../../fixtures/rooms-api';
import { RoomsPage } from '../../../pages/RoomsPage';
import type { BasePage } from '../../../pages/BasePage';

/**
 * A new channel lands on its conversation, and its ROOM.md is one press away
 * (DOR-3477).
 *
 * A channel the person opens starts with ROOM.md pinned on its canvas
 * (DOR-2112). A panel last left on Canvas used to show that template beside a
 * room nobody had spoken in. Now the panel lands on Room, and the empty state
 * says the notes are there, with **Open**.
 *
 * Under `tests/rooms/canvas/` for the test-mode leg, like its sibling: nothing
 * here starts an agent turn.
 */

const HINT = 'This channel has a ROOM.md for its goal and rules.';

/** Put a document on a room's canvas as the person, through the app's own route. */
async function putOnCanvas(request: APIRequestContext, roomId: string, title: string) {
  const res = await request.post(`/api/rooms/${roomId}/canvas`, {
    data: { content: { type: 'markdown', title, content: `# ${title}` } },
  });
  if (!res.ok()) throw new Error(`Could not put ${title} on the canvas: ${await res.text()}`);
}

/** Open the app on a room and wait for its masthead. */
async function openRoom(page: Page, basePage: BasePage, roomsPage: RoomsPage, roomId: string) {
  await page.goto(`/channels?id=${roomId}`);
  await basePage.waitForAppReady();
  await basePage.ensureSidebarOpen();
  await expect(roomsPage.roomHeader).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
}

/** Keep a screenshot with the run's results, named for what it shows. */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

for (const theme of ['light', 'dark'] as const) {
  test(`a new channel opens on its conversation, not its ROOM.md (${theme})`, async ({
    page,
    basePage,
    roomsApi,
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('dorkos-theme', value), theme);
    const roomsPage = new RoomsPage(page);
    const stamp = Date.now().toString(36);

    // Leave the panel on Canvas in another room, the way a person would: by
    // pressing a document's own tab. Not `openCanvasTab`, whose "Add view" menu
    // item detaches while the room's live canvas frames redraw the header.
    const before = await roomsApi.createChannel(`dor3477-before-${theme}-${stamp}`);
    await putOnCanvas(page.request, before.id, 'Earlier plan');
    await openRoom(page, basePage, roomsPage, before.id);
    await roomsPage.ensureRoomPanelOpen();
    const earlier = page.getByRole('tab', { name: /^Earlier plan/ });
    await earlier.click({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(earlier).toHaveAttribute('aria-selected', 'true');

    await roomsPage.createChannel(`dor3477 new ${theme} ${stamp}`);

    // The new channel's conversation, with the Room tab picked, not the canvas.
    await expect(page.getByText('Nothing said here yet')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    const roomMdTab = page.getByRole('tab', { name: /^ROOM\.md/ });
    await expect(roomMdTab).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.roomPanelTab).toHaveAttribute('aria-selected', 'true');
    await expect(roomMdTab).toHaveAttribute('aria-selected', 'false');

    const hint = page.getByTestId('room-md-hint');
    await expect(hint).toContainText(HINT);
    await shot(page, testInfo, `new-channel-${theme}`);

    // Open is the way to the notes.
    await hint.getByRole('button', { name: 'Open' }).click();
    await expect(roomMdTab).toHaveAttribute('aria-selected', 'true');
    await shot(page, testInfo, `room-md-opened-${theme}`);
  });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the empty state says the channel has a ROOM.md (390px)', async ({
    page,
    basePage,
    roomsApi,
  }, testInfo) => {
    const roomsPage = new RoomsPage(page);
    // Through the API: the phone's New menu is its own spec's subject. The
    // owner's create still pins ROOM.md, which is all this one needs.
    const room = await roomsApi.createChannel(`dor3477-phone-${Date.now().toString(36)}`);
    // No sidebar: on a phone it is a sheet over the room.
    await page.goto(`/channels?id=${room.id}`);
    await basePage.waitForAppReady();
    await expect(roomsPage.roomHeader).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    const hint = page.getByTestId('room-md-hint');
    await expect(hint).toContainText(HINT, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(hint.getByRole('button', { name: 'Open' })).toBeVisible();
    await shot(page, testInfo, 'new-channel-390');
  });
});
