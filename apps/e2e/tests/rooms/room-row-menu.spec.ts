import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';

// Shares one server and one room list with its neighbours, like every spec in
// this folder, so it runs one at a time with a ceiling sized for a machine
// several worktrees deep in concurrent agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * Leaving a room from the sidebar row's own menu (DOR-1233).
 *
 * The unit tests settle the menu's contents, the confirm-then-mutate wiring,
 * and the message composition — all of it in jsdom, against a mock transport.
 * What only a real browser against the real server can prove is the thing the
 * feature is actually FOR: that the wire call reaches `RoomService.removeMember`
 * and its three-way rule (`OWNER_MUST_BE_PRESENT`) verbatim, that a real
 * confirm-then-leave takes the operator off a real roster, and that the
 * refusal's own sentence is what a reader sees rather than a generic failure.
 *
 * No Claude SDK or API key: every seeded agent is silent, so nothing here can
 * trigger an agent turn.
 */
test.describe('Rooms — leaving from the sidebar row menu @smoke', () => {
  test('leaves a one-agent room, and takes the reader back to the empty state', async ({
    page,
    roomsApi,
    dashboardSidebar,
  }) => {
    const slug = `leave-solo-${roomsApi.runId}`;
    const ana = await roomsApi.registerAgent('Ana', '🦊', '#6d5ae0');
    const room = await roomsApi.createChannel(slug, slug, [ana]);

    await page.goto(`/channels?id=${room.id}`);
    // Scoped to Today: the open room is drawn there AND in Library, and an
    // unscoped `getByRole` resolves to both — Today's is the one BC-21 pins
    // to the conversation actually on screen.
    const actions = dashboardSidebar
      .zone('today')
      .getByRole('button', { name: `#${slug} actions` });
    await expect(actions).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    await actions.click();
    await page.getByRole('menuitem', { name: 'Leave channel' }).click();

    // Confirms first — nothing has left the roster yet.
    await expect(page.getByRole('alertdialog')).toHaveText(new RegExp(`Leave #${slug}\\?`));
    await page.getByRole('button', { name: 'Leave', exact: true }).click();

    // Navigated off the room this took you out of: `/channels` with no `id`
    // renders the empty state, never a room you can no longer post in.
    await expect(page.getByText('Pick a conversation')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // And the roster itself agrees — the operator's own row is gone, Ana's
    // is not. This is the assertion nothing in jsdom could make: it is the
    // real `RoomService.removeMember` this click actually reached.
    await expect
      .poll(async () => (await roomsApi.getRoom(room.id)).members.map((m) => m.author.kind), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toEqual(['agent']);
  });

  test('refuses to leave a two-agent room, and says why in its own words', async ({
    page,
    roomsApi,
    dashboardSidebar,
  }) => {
    const slug = `leave-pair-${roomsApi.runId}`;
    const ana = await roomsApi.registerAgent('Ana', '🦊', '#6d5ae0');
    const bo = await roomsApi.registerAgent('Bo', '🐝', '#f59e0b');
    const room = await roomsApi.createChannel(slug, slug, [ana, bo]);

    await page.goto(`/channels?id=${room.id}`);
    // Scoped to Today: the open room is drawn there AND in Library, and an
    // unscoped `getByRole` resolves to both — Today's is the one BC-21 pins
    // to the conversation actually on screen.
    const actions = dashboardSidebar
      .zone('today')
      .getByRole('button', { name: `#${slug} actions` });
    await expect(actions).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    await actions.click();
    await page.getByRole('menuitem', { name: 'Leave channel' }).click();
    await page.getByRole('button', { name: 'Leave', exact: true }).click();

    // The three-way rule's own sentence (`OWNER_MUST_BE_PRESENT`), not a
    // generic "Couldn't leave" with nothing more to go on.
    await expect(
      page.getByText('Two agents share this room — take one of them out before you leave it')
    ).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // Refused, not silently absorbed: the operator is still on the roster.
    const after = await roomsApi.getRoom(room.id);
    expect(after.members.map((m) => m.author.kind).sort()).toEqual(['agent', 'agent', 'human']);
  });
});
