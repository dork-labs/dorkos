import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { publishWorkingCount, tapGlobalStream } from './room-signals';

// Same shape as its sibling `room-presence.spec.ts`: one cockpit at a time, and
// a ceiling sized for a machine already running several worktrees of agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * The dot on a sidebar row that says a room has an agent working in it.
 *
 * The presence line answers "who is working on this", for the room you are
 * looking at. This answers the other half — "is anything happening over there"
 * — for every room at once, which is why it rides the global stream and carries
 * a bare count (room-presence spec §6).
 *
 * **jsdom cannot see the thing that matters here**: that the dot is drawn on the
 * right row, beside a name it does not disturb, and next to an unread badge it
 * cannot be mistaken for. Those are claims about a laid-out sidebar.
 *
 * The rooms, the sidebar and the stream are all real; only the `room_presence`
 * frames are the test's, injected into the real socket (`room-signals.ts` says
 * why, and what that does and does not prove — the server's own publishing is
 * pinned in `room-presence-sidebar.test.ts`, where the claim map is reachable).
 */
test.describe('Rooms — the sidebar says which rooms have an agent working', () => {
  test('the dot appears on the working room alone, and goes out when the work ends', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const busySlug = `e2e-dot-busy-${roomsApi.runId}`;
    const quietSlug = `e2e-dot-quiet-${roomsApi.runId}`;
    // Silenced by the fixture, so nothing here can start a real turn.
    const busy = await roomsApi.createChannel(busySlug, busySlug, [ana]);
    await roomsApi.createChannel(quietSlug, quietSlug, [ana]);
    await roomsApi.postEntries(busy.id, ['can someone check the deploy']);

    await tapGlobalStream(page);
    await page.goto('/channels');
    await expect(roomsPage.row(`#${busySlug}`)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // Nothing is working, so there is no dot on either row — not a dimmed one,
    // not a reserved space that shifts the name when it fills.
    await expect(roomsPage.rowWorkingDot(`#${busySlug}`)).toHaveCount(0);

    await publishWorkingCount(page, { roomId: busy.id, working: 1 });

    await expect(roomsPage.rowWorkingDot(`#${busySlug}`)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    // The count is in the name, which is the whole of what a reader who cannot
    // see a 6px dot gets.
    await expect(roomsPage.rowWorkingDot(`#${busySlug}`)).toHaveAccessibleName('1 agent working');
    // And the room next door is untouched: the event names one room, and a dot
    // on every row would say the whole cockpit is busy.
    await expect(roomsPage.rowWorkingDot(`#${quietSlug}`)).toHaveCount(0);

    await publishWorkingCount(page, { roomId: busy.id, working: 2 });
    await expect(roomsPage.rowWorkingDot(`#${busySlug}`)).toHaveAccessibleName('2 agents working');

    // The release. A count of zero is the server saying the room went quiet.
    await publishWorkingCount(page, { roomId: busy.id, working: 0 });
    await expect(roomsPage.rowWorkingDot(`#${busySlug}`)).toHaveCount(0);
  });
});
