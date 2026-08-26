/**
 * Clicking a search result lands you ON the message (DOR-687).
 *
 * **The sibling spec `message-search.spec.ts` stops at the URL, and that is
 * exactly the check this one exists to replace.** The address carries the
 * coordinate whether or not anything moved, so asserting on it cannot fail —
 * the whole defect class here is "the URL says one thing and the room sits
 * where it was". What can only be answered in a browser is whether the reader
 * is looking at the message: a virtualized row that is merely rendered can be a
 * thousand pixels above the fold, so this measures the row's box against the
 * scroller's (`RoomsPage.rowInViewport`).
 *
 * Three claims, and each needs a real browser for a different reason:
 *
 * 1. A hit that is OLD — buried well past the trailing page the room hydrates —
 *    is scrolled to and marked. jsdom lays nothing out, so "did it scroll" has
 *    no meaning there at all.
 * 2. A SECOND search, in the room already on screen, moves the room again. The
 *    landing is armed once per conversation and an in-place search-param
 *    navigation does not change the conversation, so this was a silent no-op
 *    for the commonest case there is.
 * 3. A hit the room's loaded history does not hold says so, once, and leaves
 *    the room at its newest message rather than pretending.
 *
 * **Nothing here reaches a model.** Rooms are seeded through `roomsApi`, which
 * silences every agent, and every post is the local human's. The index is
 * written through synchronously inside `publishEntry`, so `postEntries`
 * returning is the barrier — there is nothing to poll for.
 *
 * Every room, token and message is scoped to `roomsApi.runId`: the suite shares
 * one server, so an assertion about counts or absence would be an assertion
 * about what every other test happened to leave behind.
 */
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from '../rooms/open-cockpit';

// Eighty sequential posts is real wall-clock time, and the sibling spec sets
// the same ceiling for the same reason.
test.describe.configure({ mode: 'default', timeout: 120_000 });

/**
 * How many messages are piled on top of the needle.
 *
 * **Deliberately just UNDER the room's page size, and both bounds matter.**
 * `ROOM_ENTRY_PAGE_SIZE_DEFAULT` is 50 and the client asks for that trailing
 * page and no more, so burying the needle further than that would put it
 * outside the loaded history entirely — which is the "can't find it" case
 * (covered by its own test below), not this one. At 45 the needle is the OLDEST
 * row the room holds, and the room opens at its newest, so it starts far off
 * screen and only a real scroll brings it back.
 *
 * It is also under the ceiling `RoomsApi.postEntries` can verify: that barrier
 * polls `listEntries`, which serves the same 50, so a single call asking for
 * more than a page can never satisfy itself.
 */
const FILLER_COUNT = 45;

test.describe('Landing on a searched message', () => {
  test('scrolls an old message into view and marks it', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    const token = `zarquon${roomsApi.runId}`;
    const room = await roomsApi.createChannel(`deeplink-${roomsApi.runId}`);

    // The needle FIRST, so it is the oldest row in the room rather than merely
    // present — the room opens at its newest, so this one starts off screen.
    await roomsApi.postEntries(room.id, [`we agreed the ${token} approach would do`]);
    const [needle] = await roomsApi.listEntries(room.id);
    expect(needle).toBeDefined();
    await roomsApi.postEntries(
      room.id,
      Array.from({ length: FILLER_COUNT }, (_, i) => `filler ${i + 1} for ${roomsApi.runId}`)
    );

    // Prove the INDEX holds it, and holds it at the coordinate the product
    // navigates by — otherwise a UI failure and an indexing failure look
    // identical. `ordinal` IS the entry's `seq` for a room hit, and that
    // identity is the entire reason this feature needed no new field.
    const answer = await request.get(`/api/search?q=${token}&source=rooms`);
    expect(answer.ok()).toBe(true);
    const body = (await answer.json()) as {
      results: { container: string; ordinal: number }[];
    };
    const hit = body.results.find((result) => result.container === room.id);
    expect(hit).toBeDefined();
    expect(hit?.ordinal).toBe(needle!.seq);

    await openCockpit(basePage);
    await page.keyboard.press('ControlOrMeta+Shift+F');
    const input = page.getByTestId('message-search-input');
    await expect(input).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await input.fill(token);

    const dialog = page.getByTestId('message-search-dialog');
    const row = dialog.getByRole('option').filter({ hasText: token });
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await row.click();

    // The landing said it honoured a request rather than opening at the end.
    await expect(roomsPage.timeline).toHaveAttribute('data-landed-on', 'requested', {
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // An attribute selector rather than `#id`: entry ids are ULIDs, and a CSS
    // id selector beginning with a digit is invalid.
    const landed = page.locator(`[id="room-entry-${needle!.id}"]`);
    await expect(landed).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // **The claim the URL cannot make.** The needle is 45 messages back; the
    // room opens at its newest by default, so a room that did not move has this
    // row far above the fold — or, being virtualized, not drawn at all.
    await expect
      .poll(() => roomsPage.rowInViewport(landed), { timeout: SERVER_ROUND_TRIP_MS })
      .toBe(true);

    // And the reader can tell WHICH row answered them. Focus is the durable
    // mark; `data-landed` is deliberately transient, so it is not asserted here.
    await expect(landed).toBeFocused();
  });

  test('moves again when a second result is picked from the same room', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    // Two needles far apart in one room. The second search happens with the
    // room already on screen, which is the case the landing's per-conversation
    // arm guard used to swallow whole.
    const first = `zaphod${roomsApi.runId}`;
    const second = `trillian${roomsApi.runId}`;
    const room = await roomsApi.createChannel(`deeplink-twice-${roomsApi.runId}`);

    await roomsApi.postEntries(room.id, [`the ${first} decision was made here`]);
    const [needleOne] = await roomsApi.listEntries(room.id);
    await roomsApi.postEntries(
      room.id,
      Array.from({ length: 20 }, (_, i) => `middle ${i + 1} for ${roomsApi.runId}`)
    );
    await roomsApi.postEntries(room.id, [`and then the ${second} decision replaced it`]);
    // **Messages after the second needle too, and they are load-bearing.** With
    // it as the newest message, a room that simply opened at the bottom would
    // have it on screen — so the assertion below would pass against the very
    // defect this test exists to catch. Both needles have to be somewhere only
    // a real move reaches.
    await roomsApi.postEntries(
      room.id,
      Array.from({ length: 15 }, (_, i) => `trailing ${i + 1} for ${roomsApi.runId}`)
    );
    const entries = await roomsApi.listEntries(room.id);
    const needleTwo = entries.find((entry) => entry.body.text.includes(second));
    expect(needleOne).toBeDefined();
    expect(needleTwo).toBeDefined();

    const seen = await request.get(`/api/search?q=${first}&source=rooms`);
    expect(seen.ok()).toBe(true);

    await openCockpit(basePage);

    /** Search for one word and open its hit in this room. */
    const openHit = async (token: string): Promise<void> => {
      await page.keyboard.press('ControlOrMeta+Shift+F');
      const input = page.getByTestId('message-search-input');
      await expect(input).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await input.fill(token);
      const dialog = page.getByTestId('message-search-dialog');
      const row = dialog.getByRole('option').filter({ hasText: token });
      await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await row.click();
      await expect(dialog).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
    };

    await openHit(first);
    const landedOne = page.locator(`[id="room-entry-${needleOne!.id}"]`);
    await expect
      .poll(() => roomsPage.rowInViewport(landedOne), { timeout: SERVER_ROUND_TRIP_MS })
      .toBe(true);

    // The second search, from inside the room the first one opened. Nothing
    // about the ROOM changes — only `?entry=` — which is precisely why this
    // used to move nothing at all.
    await openHit(second);
    const landedTwo = page.locator(`[id="room-entry-${needleTwo!.id}"]`);
    await expect
      .poll(() => roomsPage.rowInViewport(landedTwo), { timeout: SERVER_ROUND_TRIP_MS })
      .toBe(true);
    await expect(landedTwo).toBeFocused();
  });

  test('says so, and opens normally, when the message is not in what is loaded', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    // Addressed by hand rather than through a hit, because the product cannot
    // produce this state on its own today — it is the stale link, the shared
    // address, and the room that has since grown past its trailing page.
    const room = await roomsApi.createChannel(`deeplink-gone-${roomsApi.runId}`);
    await roomsApi.postEntries(room.id, [`only message for ${roomsApi.runId}`]);

    await openCockpit(basePage);
    await page.goto(`/channels?id=${room.id}&entry=999999`);

    await expect(page.getByText("DorkOS can't find that message in what's open here")).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    // And the room is where it always opens, rather than stuck waiting for a
    // message that is not coming.
    await expect(roomsPage.timeline).toHaveAttribute('data-landed-on', 'end', {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });
});
