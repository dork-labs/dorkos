import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { visibleText } from '../../pages/RoomsPage';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from './open-cockpit';

// Same reasoning as `room-identity.spec.ts`: these share one server and one room
// list, so they run one at a time with a ceiling sized for a machine that is
// several worktrees deep in concurrent agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/** The command palette's cmdk root, and what is inside it. */
function paletteIn(page: Page): { root: Locator; input: Locator; options: Locator } {
  const root = page.locator('[cmdk-root]');
  return {
    root,
    input: root.getByPlaceholder('Search rooms, agents, commands...'),
    options: root.getByRole('option'),
  };
}

/** Open the palette with the shortcut a person would use, and wait for it. */
async function openPalette(page: Page): Promise<ReturnType<typeof paletteIn>> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = paletteIn(page);
  await expect(palette.input).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
  return palette;
}

/**
 * Open a room and wait until the server agrees the reader is caught up on it.
 *
 * Reading is what clears unread, and the palette's whole claim is about which
 * rooms still have something waiting — so a test that moved on before the read
 * cursor landed would be asserting against a state that had not settled.
 * The gate is the server's own answer, not a rendered badge.
 */
async function readRoomFully(
  page: Page,
  request: APIRequestContext,
  roomId: string
): Promise<void> {
  await page.goto(`/channels?id=${roomId}`);
  await expect
    .poll(
      async () => {
        const res = await request.get('/api/rooms');
        if (!res.ok()) return null;
        const { rooms } = (await res.json()) as { rooms: { id: string; unreadCount: number }[] };
        return rooms.find((r) => r.id === roomId)?.unreadCount ?? null;
      },
      { timeout: SERVER_ROUND_TRIP_MS }
    )
    .toBe(0);
}

/**
 * Rooms in the command palette (spec `rooms` §13.2), in a browser.
 *
 * Two of the claims here cannot be settled anywhere else. **Order** is a claim
 * about a painted list, and jsdom paints nothing — every element there is 0×0.
 * **What a row is called** is a claim about the accessibility tree, and the two
 * defects this programme shipped — `# #general`, and `#general 3 unread in
 * #general` — were both green in every unit test and obvious the moment a
 * browser computed a name.
 *
 * The unread channel is seeded FIRST and the read one SECOND, so the read one
 * is the more recently active of the two. Recency alone would therefore put the
 * read one on top; only unread-first can produce the order asserted below.
 *
 * The sidebar is deliberately never touched: these navigate by URL and gate on
 * the API, so a change to a sidebar row cannot make a palette test red.
 *
 * No Claude SDK or API key: rooms are seeded over REST and every seeded agent is
 * silent, so nothing here can trigger an agent turn.
 */
test.describe('Rooms in the command palette @smoke', () => {
  test.beforeEach(async ({ roomsApi }) => {
    await roomsApi.dismissOnboarding();
  });

  test('leads with the unread channel, and names it once', async ({
    page,
    request,
    basePage,
    roomsApi,
  }) => {
    const unreadSlug = `pal-unread-${roomsApi.runId}`;
    const readSlug = `pal-read-${roomsApi.runId}`;

    // Seeded first, so it is the OLDER of the two.
    const unread = await roomsApi.createChannel(unreadSlug);
    await roomsApi.postEntries(unread.id, ['first', 'second']);

    // Seeded second and posted into last, so it is the more recent one.
    const read = await roomsApi.createChannel(readSlug);
    await roomsApi.postEntries(read.id, ['later']);

    await openCockpit(basePage);
    await readRoomFully(page, request, read.id);

    const palette = await openPalette(page);

    // 1. The very first row of the palette is something unread — not an agent,
    //    not a feature, not a suggestion. This is what makes Cmd+K then Enter
    //    mean "go to the thing that needs me".
    await expect(palette.options.first()).toHaveAccessibleName(/ \d+ unread$/, {
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // 2. And this channel is one of them, named once, with its count. The whole
    //    announced name, not a substring: `toContainText` would be satisfied by
    //    "#slug 2 unread in #slug", which is the defect (DOR-583).
    const unreadRow = palette.options.filter({ hasText: unreadSlug }).first();
    await expect(unreadRow).toHaveAccessibleName(`#${unreadSlug} 2 unread`);
    // The `#` is drawn as a mark, so the visible run of text must not repeat it.
    expect(await visibleText(unreadRow)).toBe(`${unreadSlug} 2`);

    // 3. The read channel is absent, even though it spoke more recently. An
    //    untyped palette shows what is waiting, not the whole room list.
    await expect(palette.options.filter({ hasText: readSlug })).toHaveCount(0);

    // 4. And the whole point: Enter goes there. Being drawn first and being
    //    what Enter opens are different claims — cmdk's selection is its own
    //    state, and a first row that is not the selected one would satisfy
    //    every assertion above and still send `Cmd+K → Enter` somewhere else.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/channels\\?.*id=${unread.id}`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });

  test('# lists the channels, unread first, and opens the one you pick', async ({
    page,
    request,
    basePage,
    roomsApi,
  }) => {
    const unreadSlug = `pal-hash-unread-${roomsApi.runId}`;
    const readSlug = `pal-hash-read-${roomsApi.runId}`;

    const unread = await roomsApi.createChannel(unreadSlug);
    await roomsApi.postEntries(unread.id, ['first']);
    const read = await roomsApi.createChannel(readSlug);
    await roomsApi.postEntries(read.id, ['later']);

    await openCockpit(basePage);
    await readRoomFully(page, request, read.id);

    const palette = await openPalette(page);
    await palette.input.fill('#pal-hash-');

    const unreadRow = palette.options.filter({ hasText: unreadSlug }).first();
    const readRow = palette.options.filter({ hasText: readSlug }).first();
    await expect(unreadRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(readRow).toBeVisible();

    // The ordering claim itself, measured as painted position rather than as
    // DOM order — the two agree here, and only one of them is what a person
    // sees. The read channel spoke last, so recency alone would invert this.
    const unreadTop = (await unreadRow.boundingBox())!.y;
    const readTop = (await readRow.boundingBox())!.y;
    expect(unreadTop).toBeLessThan(readTop);

    // `#` is a scope: no features, no quick actions, no agents.
    await expect(palette.options.filter({ hasText: 'Settings' })).toHaveCount(0);
    await expect(palette.options.filter({ hasText: 'Toggle Theme' })).toHaveCount(0);

    await unreadRow.click();
    await expect(page).toHaveURL(new RegExp(`/channels\\?.*id=${unread.id}`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });

  test('@ offers the conversation with an agent beside the agent herself', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const agent = await roomsApi.registerAgent(
      `E2E Palette Otter ${roomsApi.runId}`,
      '🦦',
      '#3b82f6'
    );
    const dm = await roomsApi.createDirectMessage(agent.name, [agent]);

    await openCockpit(basePage);
    const palette = await openPalette(page);
    await palette.input.fill(`@${agent.name}`);

    // Two rows, two different acts: message the conversation, or open the agent.
    const message = palette.options.filter({ hasText: `Message ${agent.name}` }).first();
    await expect(message).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(message).toHaveAccessibleName(`Message ${agent.name}`);
    // Exactly two: the conversation and the agent. Not "more than one" — the
    // number is knowable, and a third row would be a duplicate nobody wants.
    await expect(palette.options.filter({ hasText: agent.name })).toHaveCount(2);

    await message.click();
    await expect(page).toHaveURL(new RegExp(`/channels\\?.*id=${dm.id}`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });
});
