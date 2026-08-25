import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { visibleText } from '../../pages/RoomsPage';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { SEARCH_HANDOFF_ROW } from '../../pages/command-palette';
import { openCockpit } from './open-cockpit';

// Same reasoning as `room-identity.spec.ts`: these share one server and one room
// list, so they run one at a time with a ceiling sized for a machine that is
// several worktrees deep in concurrent agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/** The command palette's cmdk root, and what is inside it. */
function paletteIn(page: Page): {
  root: Locator;
  input: Locator;
  options: Locator;
  results: Locator;
  handoff: Locator;
} {
  const root = page.locator('[cmdk-root]');
  const options = root.getByRole('option');
  return {
    root,
    // By test id, not the placeholder: that string is user-facing copy and this
    // spec is not the place to pin its wording.
    input: page.getByTestId('command-palette-input'),
    options,
    // The rows the ranking produced, without ⌘K's hand-off to message search
    // (DOR-685). The hand-off draws the typed query back at you, so it matches
    // whatever text a row filter is looking for — and it is not a result, so no
    // count of results may include it.
    results: options.filter({ hasNotText: SEARCH_HANDOFF_ROW }),
    handoff: options.filter({ hasText: SEARCH_HANDOFF_ROW }),
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
  test('surfaces an unread channel without typing, and names it once', async ({
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

    // 1. An unread channel surfaces in the untyped palette, and this one does.
    //
    //    This used to assert `palette.options.first()` — that the palette LEADS
    //    with something unread. That is a claim about every room on the server,
    //    and the suite runs its specs against one: any neighbour holding an
    //    unread room falsified it. Worse, step 4's Enter then opened that
    //    neighbour's room, and arriving at a room marks it read — this test was
    //    silently clearing another spec's unread badge, which is what made
    //    `room-identity`'s unread test fail about half the time.
    //
    //    Scoped to the rooms this test seeded, the surviving claim is the one it
    //    can own: waiting work reaches an untyped palette without being asked
    //    for. Which row is globally first is not assertable here.
    const unreadRow = palette.options.filter({ hasText: unreadSlug }).first();
    await expect(unreadRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // 2. Named once, with its count. The whole announced name, not a substring:
    //    `toContainText` would be satisfied by "#slug 2 unread in #slug", which
    //    is the defect (DOR-583).
    await expect(unreadRow).toHaveAccessibleName(`#${unreadSlug} 2 unread`);
    // The `#` is drawn as a mark, so the visible run of text must not repeat it.
    expect(await visibleText(unreadRow)).toBe(`${unreadSlug} 2`);

    // 3. The unread channel is ABOVE this test's read one, even though the read
    //    one spoke more recently.
    //
    //    This used to assert the read channel was absent entirely. The untyped
    //    palette is a command center now (spec `sidebar-now-today-library` §15):
    //    its Recent list is where you have BEEN, so a caught-up channel belongs
    //    in it. What did not change is which one a person reaches first — and
    //    that is the claim worth keeping, because recency alone would invert it.
    const readRow = palette.options.filter({ hasText: readSlug }).first();
    await expect(readRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    const [unreadTop, readTop] = await unreadRow.evaluate(
      (unreadEl, readEl) => [unreadEl.getBoundingClientRect().y, readEl!.getBoundingClientRect().y],
      await readRow.elementHandle()
    );
    expect(unreadTop).toBeLessThan(readTop!);

    // 4. And the whole point: Enter goes to the row cmdk has selected, not
    //    merely to the row drawn first — they are different claims, and a
    //    selection that lags the list would satisfy everything above and still
    //    send `Cmd+K → Enter` somewhere else.
    //
    //    Typing this run's prefix narrows the palette to rooms this test made,
    //    so the selected row is deterministically ours. Without it, Enter went
    //    wherever the shared server's first unread row happened to be — which is
    //    both unassertable and how this test perturbed its neighbours.
    await palette.input.fill(`#pal-unread-${roomsApi.runId}`);
    await expect(palette.options.filter({ hasText: unreadSlug }).first()).toBeVisible();
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
    //
    // Both tops come out of ONE evaluate. As two awaited `boundingBox()` calls,
    // a palette re-render between them could measure the rows against different
    // layouts and invert the comparison — seen once as a flake. One trip reads
    // both from the same layout, whichever layout that is.
    const [unreadTop, readTop] = await unreadRow.evaluate(
      (unreadEl, readEl) => [unreadEl.getBoundingClientRect().y, readEl!.getBoundingClientRect().y],
      await readRow.elementHandle()
    );
    expect(unreadTop).toBeLessThan(readTop!);

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

    // Two rows, two different acts: open the conversation, or open the agent.
    const conversation = palette.options
      .filter({ hasText: `Open conversation with ${agent.name}` })
      .first();
    await expect(conversation).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(conversation).toHaveAccessibleName(`Open conversation with ${agent.name}`);
    // Exactly two RESULTS: the conversation and the agent. Not "more than one"
    // — the number is knowable, and a third result would be a duplicate nobody
    // wants.
    //
    // Counted over `results` rather than every option, because ⌘K's hand-off
    // row draws the typed query — which here IS the agent's name — so on
    // `options` it pads this number by one and the assertion stops being about
    // duplicates (DOR-685). The two lines below name the row that was excluded,
    // so "two" cannot be reached by a filter that quietly dropped a result.
    await expect(palette.results.filter({ hasText: agent.name })).toHaveCount(2);
    await expect(palette.handoff).toHaveCount(1);
    await expect(palette.handoff).toContainText(agent.name);

    await conversation.click();
    await expect(page).toHaveURL(new RegExp(`/channels\\?.*id=${dm.id}`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });
});
