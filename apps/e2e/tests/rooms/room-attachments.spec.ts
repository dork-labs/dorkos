import { join } from 'node:path';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { BasePage } from '../../pages/BasePage';
import { RoomsPage } from '../../pages/RoomsPage';
import { openCockpit } from './open-cockpit';

// Same budget and same scheduling as `room-conversation.spec.ts`, for the same
// reason: these tests seed a room, load a whole cockpit, and — here — a second
// one, which is load the product never sees eleven of at once. Independent
// (`default`, not `serial`); each seeds its own room.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/** The two committed fixtures, one verifiable image and one thing that is not. */
const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'attachments');
const IMAGE_PATH = join(FIXTURES, 'room-mark.png');
const IMAGE_NAME = 'room-mark.png';
const LOG_PATH = join(FIXTURES, 'agent-run.log');
const LOG_NAME = 'agent-run.log';

/**
 * Attaching a file in a room, and what everybody else can then reach.
 *
 * **The first file-input coverage this suite has ever had.** `setInputFiles`
 * appears nowhere else in `apps/e2e`, for chat or anything, so the composer's
 * paperclip and the timeline's thumbnails were until now asserted only in jsdom
 * — which loads no bytes, decodes no image, and never asks a server for one.
 *
 * Three things live only here:
 *
 * - **The round trip is real.** The composer holds a `blob:` URL for the file it
 *   is about to send; the timeline holds the server's URL for the file that
 *   arrived. jsdom cannot tell those apart, because it renders neither. A second
 *   window that never held the bytes is what makes "the image is on screen" a
 *   claim about the server rather than about the sender's own memory.
 * - **The image really is an image.** `naturalWidth` is Chromium's answer to
 *   "did these bytes decode", and it is the only assertion in the tree that
 *   fails when the serve route hands back the right status and the wrong bytes.
 * - **The file is scoped to its room.** Same reader, same file id, one room
 *   segment different — 200 becomes 404.
 *
 * No Claude SDK or API key: a channel created here has no agent members, so a
 * post triggers nobody.
 */
test.describe('Rooms — attaching files @smoke', () => {
  test('attach two files, send them, and let a second window read them back', async ({
    page,
    browser,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    await openCockpit(basePage);

    // Created through the sidebar rather than seeded, because the attach path
    // starts at a composer and the composer belongs to a room somebody made.
    const name = `E2E Attach ${roomsApi.runId}`;
    const slug = `e2e-attach-${roomsApi.runId}`;
    await roomsPage.createChannel(name);
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    const roomId = new URL(page.url()).searchParams.get('id')!;
    roomsApi.track(roomId);
    await expect(roomsPage.roomHeading).toHaveAccessibleName(`#${slug}`);

    // Two files, one input, one gesture — the `multiple` on the file input is
    // the product's promise that a person picks a set rather than repeating
    // themselves.
    await roomsPage.attach(`#${slug}`, [IMAGE_PATH, LOG_PATH]);

    // Both are waiting above the box, each naming itself. Counted as well as
    // named: a bar that drew one chip twice would satisfy either name alone.
    await expect(roomsPage.composerChips(`#${slug}`)).toHaveCount(2);
    await expect(roomsPage.composerChip(`#${slug}`, IMAGE_NAME)).toBeVisible();
    await expect(roomsPage.composerChip(`#${slug}`, LOG_NAME)).toBeVisible();

    const composer = roomsPage.composer(`#${slug}`);
    await roomsPage.post(`#${slug}`, 'Both of these came off my machine.');

    // Nothing is drawn until the server's copy arrives back on the room's
    // stream, so this asserts the round trip and not an optimistic echo — the
    // pending row the composer draws in the meantime is a `room-pending`, and
    // `entries` counts only `room-entry`.
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    const entry = roomsPage.entries.first();
    await expect(entry).toContainText('Both of these came off my machine.');

    // The two shapes, and which file got which is the whole assertion. `preview`
    // is set from the BYTES the server sniffed, so a renderer that branched on
    // the declared type — or a server that trusted one — puts the `.log` in an
    // `<img>` and fails here.
    await expect(roomsPage.attachmentImage(entry, IMAGE_NAME)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.attachmentChip(entry, LOG_NAME)).toBeVisible();
    // And the log is NOT an image, stated rather than left to the absence of an
    // assertion: `getByRole('img')` over the block must resolve to exactly the
    // one file the server verified.
    await expect(roomsPage.attachmentsIn(entry).getByRole('img')).toHaveCount(1);

    // The composer is empty on both counts — the bar has let the files go, and
    // the box is free for the next sentence. `Composer.Attachments` unmounts
    // entirely at zero, so the count is the honest question to ask it.
    await expect(roomsPage.composerChips(`#${slug}`)).toHaveCount(0);
    await expect(composer).toHaveValue('');

    // The URL the timeline is pointing at. Read off the rendered element rather
    // than rebuilt from ids, because "the URL the server wrote" is exactly what
    // the next two assertions are about.
    const imageUrl = await roomsPage.attachmentImage(entry, IMAGE_NAME).getAttribute('src');
    expect(imageUrl, 'the thumbnail should carry the server-written URL').toBeTruthy();

    // A second window, on the same room. The precedent for opening one is
    // `tests/streams/multi-window.spec.ts`; nothing in `tests/rooms/` had ever
    // needed a second reader before.
    //
    // **What this proves and what it cannot.** With login off — the suite's
    // configuration and the product's default — `resolveCaller` answers with the
    // install's owner for every unattributed request, so a second browser
    // context is the same author as the first and is a member of everything.
    // That makes "a second MEMBER sees the files" provable here and "a
    // non-member is refused" not: there is no second person to be, and the owner
    // sees every room by design (`RoomService.canSee`). The refusal this suite
    // CAN put a floor under is the room-scoping one, at the end.
    const second = await browser.newContext();
    try {
      const secondPage = await second.newPage();
      const secondBase = new BasePage(secondPage);
      const secondRooms = new RoomsPage(secondPage);
      await secondPage.goto(`/channels?id=${roomId}`);
      await secondBase.waitForAppReady();

      await expect(secondRooms.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
      const seen = secondRooms.entries.first();
      const thumbnail = secondRooms.attachmentImage(seen, IMAGE_NAME);
      await expect(thumbnail).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(secondRooms.attachmentChip(seen, LOG_NAME)).toBeVisible();

      // Rendered is not the same as decoded. This window never held the file, so
      // the only bytes behind that `<img>` came from the serve route — and a
      // route answering 404, or the right status over the wrong bytes, leaves
      // `naturalWidth` at 0 while the element stays perfectly visible.
      await expect
        .poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth), {
          timeout: SERVER_ROUND_TRIP_MS,
        })
        .toBe(16);

      // The refusal, from the reader that just displayed the file: same request,
      // one segment different.
      //
      // A second channel it is unambiguously allowed to read, so a 404 below
      // cannot be explained by "that room is not visible to you" — the only
      // thing that changed is which room the file is being asked for.
      const elsewhere = await roomsApi.createChannel(`e2e-attach-else-${roomsApi.runId}`);
      const url = new URL(imageUrl!, secondPage.url());

      const allowed = await secondPage.request.get(url.toString());
      expect(allowed.status(), 'a member reading the file in its own room').toBe(200);

      const refused = await secondPage.request.get(
        url.toString().replace(`/rooms/${roomId}/`, `/rooms/${elsewhere.id}/`)
      );
      expect(refused.status(), 'the same file id hung off another room should not resolve').toBe(
        404
      );
    } finally {
      await second.close();
    }
  });
});
