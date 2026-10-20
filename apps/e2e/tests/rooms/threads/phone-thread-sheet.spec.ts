import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS, type RoomsApi } from '../../../fixtures/rooms-api';
import { PHONE } from '../room-sheet-helpers';

// One cockpit at a time, with a ceiling for a busy machine. Every entry is the
// operator's, in a room with no agent in it, so nothing here starts a turn.
test.describe.configure({ mode: 'default', timeout: 120_000 });

/**
 * A thread on a phone is a full-screen sheet over its room (DOR-3078).
 *
 * It slides in from the right, the message it hangs off stays pinned under the
 * header, "← #room" takes you back, a swipe to the right does too, and the room
 * underneath keeps its place. Only a laid-out page can say any of that: jsdom
 * has no geometry, no scrolling and no touch.
 */
test.describe('Rooms — the thread sheet on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  /**
   * A room tall enough to scroll, with one thread in it.
   *
   * **The thread hangs off the NEWEST message.** A room opens at its newest
   * message and its timeline is virtualized, so a reply row thirty messages up
   * is never mounted and nothing can find it. History goes in first, so the
   * room still scrolls, and the thread's reply row is on screen at the bottom.
   */
  async function seedRoom(roomsApi: RoomsApi) {
    const slug = `e2e-thread-sheet-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(
      room.id,
      Array.from({ length: 30 }, (_, i) => `earlier line ${i} ${'and some more words '.repeat(3)}`)
    );
    await roomsApi.postEntries(room.id, [`What should we call the release? ${roomsApi.runId}`]);
    const ids = await roomsApi.entryIds(room.id);
    const rootEntryId = ids[ids.length - 1]!;
    await roomsApi.postThreadReply(room.id, rootEntryId, 'Something short.');
    await roomsApi.postThreadReply(room.id, rootEntryId, 'Something with a number in it.');
    return { slug, room };
  }

  /** The room's own scroller. */
  function roomScroller(page: Page) {
    return page.getByTestId('room-timeline').locator('xpath=..');
  }

  /** Open the thread from its reply row, scrolling the room to it first. */
  async function openThread(page: Page) {
    const row = page.getByTestId('room-thread-replies').first();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await expect(page.getByTestId('room-thread-sheet')).toBeVisible();
  }

  test('slides over the room, pins its root, and Back returns to the same place', async ({
    page,
    roomsApi,
  }) => {
    const { slug, room } = await seedRoom(roomsApi);
    await page.goto(`/channels?id=${room.id}`);
    const scroller = roomScroller(page);
    await expect(page.getByTestId('room-thread-replies').first()).toBeAttached({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    await openThread(page);
    const parked = await scroller.evaluate((el) => el.scrollTop);

    const sheet = page.getByTestId('room-thread-sheet');
    // Full screen over the room, which is still there underneath.
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox?.width).toBeGreaterThanOrEqual(PHONE.width - 1);
    await expect(page.getByTestId('room-under-thread')).toHaveAttribute('inert', '');
    await expect(page.getByTestId('room-timeline')).toBeAttached();

    // The root is pinned under the header, and the replies scroll beneath it.
    const pinned = page.getByTestId('room-thread-pinned-root');
    await expect(pinned).toContainText(`What should we call the release? ${roomsApi.runId}`);
    await expect(page.getByTestId('room-thread-feed')).toContainText('Something short.');
    await expect(page.getByTestId('room-thread-feed')).not.toContainText(
      'What should we call the release?'
    );

    // "← #room" — named for where it goes.
    const back = page.getByTestId('room-thread-back');
    await expect(back).toHaveText(`#${slug}`);
    await back.click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('room-under-thread')).not.toHaveAttribute('inert', '');
    // The room kept its place: the same scroller, at the same offset.
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(parked);
  });

  test('a swipe to the right closes it', async ({ page, roomsApi }) => {
    const { room } = await seedRoom(roomsApi);
    await page.goto(`/channels?id=${room.id}`);
    await expect(page.getByTestId('room-thread-replies').first()).toBeAttached({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await openThread(page);
    const sheet = page.getByTestId('room-thread-sheet');
    // Let the slide finish before the swipe begins.
    await expect.poll(async () => (await sheet.boundingBox())?.x ?? -1).toBeLessThanOrEqual(1);

    // A real finger, through CDP: a pointer drag from the header's middle
    // across most of the screen.
    const header = page.getByTestId('room-thread-panel').locator('header');
    const box = await header.boundingBox();
    if (box === null) throw new Error('the thread header has no box');
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 120, y }],
    });
    for (const x of [140, 180, 230, 280, 330]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();

    await expect(sheet).toHaveCount(0, { timeout: 5_000 });
  });

  test('cuts rather than slides for a reader who asked for less motion', async ({
    page,
    roomsApi,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { room } = await seedRoom(roomsApi);
    await page.goto(`/channels?id=${room.id}`);
    await expect(page.getByTestId('room-thread-replies').first()).toBeAttached({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await openThread(page);
    // In place at once: no frame of it travelling in from the right.
    expect((await page.getByTestId('room-thread-sheet').boundingBox())?.x).toBe(0);
  });

  test('opens from the Threads page as the same sheet', async ({ page, roomsApi }) => {
    const { slug } = await seedRoom(roomsApi);
    await page.goto('/threads');
    const card = page.getByTestId('thread-card').filter({ hasText: `#${slug}` });
    await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await card.getByRole('button', { name: `#${slug}`, exact: true }).click();

    await expect(page.getByTestId('room-thread-sheet')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(page.getByTestId('room-thread-pinned-root')).toContainText(
      'What should we call the release?'
    );
  });
});
