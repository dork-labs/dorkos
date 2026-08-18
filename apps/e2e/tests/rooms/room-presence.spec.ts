import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { publishPresence, tapRoomStream } from './room-signals';

// Same shape as its sibling `room-conversation.spec.ts`: one cockpit at a time,
// and a ceiling sized for a machine already running several worktrees of agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * Waiting on an agent, and being told so.
 *
 * Between posting a question and reading the answer the room used to show
 * nothing, for up to ten minutes of sanctioned wait. It now shows who picked it
 * up, for how long, and when the wait has gone past normal.
 *
 * **jsdom cannot see any of this.** The line renders under the composer, counts
 * up on a timer nothing on the wire drives, and disappears rather than leaving a
 * gap — three claims about a laid-out page. This repo has shipped room defects
 * that every jsdom test passed and a screenshot caught, twice.
 *
 * The room, its history and its live stream are all real; only the presence
 * signals are the test's, injected into the real stream (`room-signals.ts` says
 * why, and what that does and does not prove).
 */
test.describe('Rooms — the room says who is working on it', () => {
  test('the line names the agent, counts up, goes late, and clears when the work is released', async ({
    page,
    roomsApi,
    roomsPage,
    request,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const slug = `e2e-presence-${roomsApi.runId}`;
    // Silenced by the fixture, so nothing here can start a real turn. The claim
    // this line is about is published below rather than run.
    const room = await roomsApi.createChannel(slug, slug, [ana]);
    await roomsApi.postEntries(room.id, ['can someone check the deploy']);

    // The two ids the dispatcher would key its publish on: the agent's author id
    // off the roster, and the entry whose trigger it is answering.
    const roster = await roomsApi.getRoom(room.id);
    const anaAuthorId = roster.members.find((member) => member.author.kind === 'agent')!.author.id;
    const entries = await request.get(`/api/rooms/${room.id}/entries`);
    const { entries: stored } = (await entries.json()) as { entries: { id: string }[] };
    const triggerId = stored[0]!.id;

    await tapRoomStream(page);
    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    // Nothing is happening, so there is nothing there — not an empty strip
    // holding a place under the composer. The announcer IS there, and empty:
    // a live region has to exist before its text does, or the arrival of both
    // at once goes unannounced.
    await expect(roomsPage.presenceLine).toHaveCount(0);
    await expect(roomsPage.presenceAnnouncer).toBeAttached();
    await expect(roomsPage.presenceAnnouncer).toHaveText('');

    await publishPresence(page, {
      authorId: anaAuthorId,
      state: 'working',
      entryId: triggerId,
      since: new Date().toISOString(),
    });

    await expect(roomsPage.presenceLine).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // The sentence and no number, because the claim is seconds old. A timer that
    // starts at `0s` draws the eye for nothing, so the line waits ten seconds
    // before it puts one up (`unified-conversation` design record; the constant
    // is `LANE_TIMER_FLOOR_MS`). This assertion used to require `· \d+s` here
    // and is the one place in this suite the live lane changed what a person
    // sees rather than only where they see it.
    await expect(roomsPage.presenceLine).toHaveText(`${ana.name} is working on it`);
    // The sentence, without the number that ticks: the region says what happened
    // once, rather than re-reading itself every second.
    await expect(roomsPage.presenceAnnouncer).toHaveText(`${ana.name} is working on it`);

    // It counts up on its own: nothing else is published between here and the
    // assertion, so a line that only redrew on an event would never show one at
    // all. Ten past the floor, so the number has to have arrived AND advanced.
    await expect
      .poll(
        async () =>
          Number(/· (\d+)s/.exec((await roomsPage.presenceLine.textContent()) ?? '')?.[1] ?? 0),
        {
          timeout: 20_000,
        }
      )
      .toBeGreaterThanOrEqual(11);

    await publishPresence(page, {
      authorId: anaAuthorId,
      state: 'working_late',
      entryId: triggerId,
      since: new Date(Date.now() - 12 * 60_000).toISOString(),
    });
    await expect(roomsPage.presenceLine).toHaveText(
      `${ana.name} is still working — this is taking longer than usual · 12m`
    );
    // The wording changed, so this one IS worth saying again.
    await expect(roomsPage.presenceAnnouncer).toHaveText(
      `${ana.name} is still working — this is taking longer than usual`
    );

    // A real post, over the real stream the tap is piping through — so the room
    // is still live, and one member speaking does not release another's work.
    await roomsPage.post(`#${slug}`, 'no rush');
    await expect(roomsPage.entries).toHaveCount(2, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.presenceLine).toBeVisible();

    // The release. The server publishes this after the durable write it
    // accompanies, so the indicator never drops before the answer explaining it.
    await publishPresence(page, {
      authorId: anaAuthorId,
      state: 'done',
      entryId: triggerId,
      since: new Date().toISOString(),
    });
    await expect(roomsPage.presenceLine).toHaveCount(0);
    await expect(roomsPage.presenceAnnouncer).toHaveText('');
  });
});
