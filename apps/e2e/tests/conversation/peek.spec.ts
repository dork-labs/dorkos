import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { publishPresence, tapRoomStream } from '../rooms/room-signals';

// Same shape as its siblings in `tests/rooms`: one cockpit at a time, and a
// ceiling sized for a machine already running several worktrees of agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * What the live lane opens into.
 *
 * The lane holds one truncated sentence; the peek holds the rest of it — who,
 * for how long, what they are answering, and the two things a person watching
 * wants. Three of its claims are only true in a laid-out browser: that the
 * popover opens over the composer without taking the caret, that "replying
 * to…" really takes the reader to that entry, and that the Stop it offers says
 * how many agents it will take down.
 *
 * The room, its history and its stream are real; only the presence signals are
 * the test's (`room-signals.ts`). The halt at the end is a REAL request against
 * the real route, which is why the room's own `halted` notice lands.
 */
test.describe('Conversation — the peek behind the live lane', () => {
  test('two agents working: the peek names both, jumps to what one is answering, and stops the room honestly', async ({
    page,
    roomsApi,
    roomsPage,
    request,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const bo = await roomsApi.registerAgent(`E2E Bo ${roomsApi.runId}`, '🦉', '#3b82f6');
    const slug = `e2e-peek-${roomsApi.runId}`;
    // Silenced by the fixture, so nothing here can start a real turn. The claims
    // below are published rather than run.
    const room = await roomsApi.createChannel(slug, slug, [ana, bo]);
    await roomsApi.postEntries(room.id, [
      'can you log today’s decisions?',
      'and can somebody check the deploy',
    ]);

    const roster = await roomsApi.getRoom(room.id);
    // By NAME, not by roster order: the two rows below are asserted in the order
    // the lane sorts them (oldest claim first), and matching that to the roster's
    // own order would pass or fail on how the server happened to list them.
    const authorIdOf = (displayName: string): string =>
      roster.members.find((member) => member.author.displayName === displayName)!.author.id;
    const anaAuthorId = authorIdOf(ana.name);
    const boAuthorId = authorIdOf(bo.name);
    const entries = await request.get(`/api/rooms/${room.id}/entries`);
    const { entries: stored } = (await entries.json()) as { entries: { id: string }[] };
    const [firstEntryId, secondEntryId] = [stored[0]!.id, stored[1]!.id];

    await tapRoomStream(page);
    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(2, { timeout: SERVER_ROUND_TRIP_MS });

    const started = Date.now();
    await publishPresence(page, {
      authorId: anaAuthorId,
      state: 'working',
      entryId: firstEntryId,
      since: new Date(started - 64_000).toISOString(),
    });
    await publishPresence(page, {
      authorId: boAuthorId,
      state: 'working',
      entryId: secondEntryId,
      since: new Date(started - 20_000).toISOString(),
    });

    // The lane counts rather than naming, because two names plus two clocks do
    // not fit a 24-pixel line — the peek is where the rest of it lives.
    await expect(roomsPage.presenceLine).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.presenceLine).toContainText('are working on it');

    // Put the caret in the composer first: opening the peek must not take it.
    const composer = page.getByRole('combobox', { name: /Message/ });
    await composer.click();
    await expect(composer).toBeFocused();

    await page.getByRole('button', { name: 'Show who is working' }).click();
    const peek = page.getByTestId('live-peek');
    await expect(peek).toBeVisible();

    // One row per agent, each with its own name and its own clock — the older
    // claim first, which is the order the sentence above it speaks in.
    const rows = page.getByTestId('live-peek-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(ana.name);
    await expect(rows.nth(0)).toContainText('1m');
    await expect(rows.nth(1)).toContainText(bo.name);
    // Bo's claim was published twenty seconds old and has been ticking on the
    // client's clock ever since — through the navigation, the stream tap and
    // the click above. On a busy CI runner that is a few seconds, not zero, so
    // the row is asserted to read twenty-something up to fifty-something
    // seconds rather than the literal `20s` (which failed the merge queue once).
    //
    // No trailing `\b`: the row's text runs the elapsed reading straight into
    // the "Replying to …" line below it (`20sReplying`), and a word boundary
    // needs a NON-word character after the `s` — so the anchored form could
    // never match a row that had a link on it. `(?![a-z])` asks the same
    // question the boundary was meant to ask: the seconds are their own word,
    // not the front of `20something`.
    await expect(rows.nth(1)).toContainText(/\b[2-5]\ds(?![a-z])/u);

    // No per-row Stop with two agents working, and one footer action that says
    // exactly what it will do. A button never stops work you did not mean to.
    await expect(page.getByTestId('live-peek-stop')).toHaveCount(0);
    const stopAll = page.getByTestId('live-peek-stop-all');
    await expect(stopAll).toContainText('Stop everything in this room');
    await expect(stopAll).toContainText('Stops all 2');

    // Neither agent has ever answered here, so nothing is bound — and the link
    // is ABSENT rather than disabled. A control that cannot do anything is a
    // promise the product is not keeping.
    //
    // **The positive case is deliberately not here.** A binding is written by a
    // room TURN and by nothing else — there is no route that mints one — and
    // this suite silences its agents precisely so no turn can run. Making one
    // run would ask a real model for a real answer. So the two halves are pinned
    // where each is free: the route's own answers in
    // `apps/server/src/routes/__tests__/rooms-sessions.test.ts`, and the link
    // this draws from them in `RoomLiveLane.test.tsx` ("offers the session an
    // agent's work runs in, and asks for it only on open").
    await expect(page.getByTestId('live-peek-open-session')).toHaveCount(0);

    // "Replying to…" takes the reader to the entry, and leaves them standing on
    // it — the row is a tab stop with a focus ring, so focus IS the flash.
    await expect(rows.nth(0)).toContainText('can you log today’s decisions?');
    await rows.nth(0).getByTestId('live-peek-replying-to').click();
    const firstRow = page.locator(`#room-entry-${firstEntryId}`);
    await expect(firstRow).toBeFocused();
    await expect(firstRow).toBeInViewport();

    // Stop, for real, against the real route.
    await page.getByRole('button', { name: 'Show who is working' }).click();
    await page.getByTestId('live-peek-stop-all').click();

    // The room says so in its own voice, whether or not anything was running —
    // pressing Stop is a question and silence is not an answer to it.
    await expect(
      roomsPage.notices.filter({ hasText: 'Everything here was stopped' }).first()
    ).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // And the lane clears. The `done` signals are the test's, exactly as the
    // `working` ones were: the dispatcher publishes one per claim it releases,
    // and it held none of these because nothing here ever ran a turn.
    for (const [authorId, entryId] of [
      [anaAuthorId, firstEntryId],
      [boAuthorId, secondEntryId],
    ] as const) {
      await publishPresence(page, {
        authorId,
        state: 'done',
        entryId,
        since: new Date(started).toISOString(),
      });
    }
    await expect(roomsPage.presenceLine).toHaveCount(0);
    await expect(roomsPage.presenceAnnouncer).toHaveText('');
    // Blank, and still exactly as tall.
    const lane = page.locator('[data-slot="live-lane"]');
    expect(await lane.evaluate((node) => Math.round(node.getBoundingClientRect().height))).toBe(24);
  });
});
