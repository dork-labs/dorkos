import { test, expect } from '../../fixtures';
import { visibleText } from '../../pages/RoomsPage';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from './open-cockpit';

// Opted out of the project-wide `fullyParallel`, and given a longer budget than
// the 30s the lighter specs run under.
//
// These tests share one server and one room list, and eleven cockpits loading at
// once is load the product never sees. They stay independent (`default`, not
// `serial`) — each seeds its own rooms, so a failure never cascades — but they
// run one at a time.
//
// The budget is a ceiling, not a wait: on an idle machine each of these finishes
// in three to eight seconds. It is sized for the machine this repo actually runs
// on, which AGENTS.md describes as routinely several worktrees of concurrent
// agents; measured against a load average north of 200, seeding two agents and
// loading a cockpit does not fit in 30s.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * How a room says who it is — in a browser, where the two defects this
 * programme shipped were obvious and every jsdom test was green.
 *
 * Both are about the same thing: a room carries its name twice on purpose, once
 * for a screen reader and once beside the mark a sighted reader sees, and the
 * two halves are individually correct in every version of this code. What
 * breaks is the composition, which only a real browser lays out.
 *
 * - Every channel read `# #general` — a `#` glyph drawn beside the text
 *   `#general` (spec `rooms` §13.1). `textContent` says `#general` either way.
 * - An unread row announced `#general 3 unread in #general` — the same name
 *   twice, one element further along (DOR-583). Nothing on screen changed.
 *
 * So each assertion here comes in a pair: what is on screen, and what is
 * announced. Asserting only the first passes on a fix that strips the `#`
 * everywhere and leaves a screen reader saying `general`; asserting only the
 * second passes on the doubled glyph. Neither alone is evidence.
 *
 * No Claude SDK or API key: rooms are seeded over REST and every seeded agent is
 * `silent`, so nothing here can trigger an agent turn.
 */
test.describe('Rooms — how a room names itself @smoke', () => {
  // Every room is seeded inside the test and BEFORE the cockpit loads, so the
  // sidebar's first read of the room list already contains it. Seeding after the
  // page was up made each test depend on catching a live `room_created` event,
  // which is a race the test does not exist to exercise.

  test('a channel wears its # as a mark, and spells it out only to a screen reader', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-sigil-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug);
    await openCockpit(basePage);

    // The sidebar row. The mark is drawn (so a fix that simply deleted the `#`
    // from the name fails here), the visible run of text is the bare name (so
    // the doubled `# #slug` fails here), and the announced name keeps the `#`
    // (so stripping the prefix outright fails here).
    const row = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.rowMark(`#${slug}`)).toBeVisible();
    expect(await visibleText(row)).toBe(slug);
    await expect(row).toHaveAccessibleName(`#${slug}`);

    // The masthead of the open room, which drew the same doubled name.
    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.roomHeading).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    expect(await visibleText(roomsPage.roomHeading)).toBe(slug);
    await expect(roomsPage.roomHeading).toHaveAccessibleName(`#${slug}`);
  });

  test('an unread channel row names itself once, and stops counting once read', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-unread-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug);
    // Three entries the reader has not seen: the local human's read cursor sits
    // at 0 until something moves it, and reading the room is the only thing
    // that does. Three is the number asserted below — not "some".
    await roomsApi.postEntries(room.id, ['first', 'second', 'third']);
    // The badge is read from the room LIST, which lags the entry write. Waiting
    // for it here keeps a slow projection from being reported as a missing badge.
    await roomsApi.waitForUnread(room.id, 3);
    await openCockpit(basePage);

    const row = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
    // The whole announced name, not a substring: `toContainText('#slug')` is
    // satisfied by "#slug 3 unread in #slug", which is the defect.
    await expect(row).toHaveAccessibleName(`#${slug} 3 unread`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    expect(await visibleText(row)).toBe(`${slug} 3`);

    // Opening the room is what marks it read.
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/channels\\?.*id=${room.id}`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.entries).toHaveCount(3, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(row).toHaveAccessibleName(`#${slug}`);
    expect(await visibleText(row)).toBe(slug);
  });

  test('a direct message is named for the agent it is with, in the sidebar and the bar', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    // The defect this guards was not broken wiring — `AuthorRef` has always
    // carried an emoji and the timeline has always drawn it. The sidebar drew a
    // hashed letter disc instead, so the same agent read as a coloured emoji in
    // the agent list and an unrelated pastel letter in the row beside it
    // (spec `rooms` §12.2). A test asserting "an avatar element exists" passes
    // on both, so these assert the glyph.
    const agent = await roomsApi.registerAgent(`E2E Otter ${roomsApi.runId}`, '🦦', '#3b82f6');
    const room = await roomsApi.createDirectMessage(agent.name, [agent]);
    await openCockpit(basePage);

    const row = roomsPage.rowIn(roomsPage.directMessages, agent.name);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.rowMark(agent.name)).toHaveText(agent.emoji);
    // What a person actually reads across that row: the agent's face, then its
    // name. A letter disc renders "E E2E Otter …" here and fails.
    expect(await visibleText(row)).toBe(`${agent.emoji} ${agent.name}`);

    // **The face assertions stop at the sidebar, and that is the product, not a
    // gap in the test.** The open room's masthead drew this agent's emoji twice
    // — once as the room's mark, once on a roster disc — and phase R1 replaced
    // it with the one bar, which draws no face at all: the fleet directory those
    // faces came from sits in a widget this layer may not import, and a hashed
    // letter here would contradict the emoji the sidebar shows two inches away.
    // So what the bar owes this test is the NAME, and the roster as a count.
    // When phase R2 rebuilds the roster in the room panel, the disc assertions
    // belong there.
    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.roomHeading).toHaveAccessibleName(agent.name, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.membersChip).toHaveAccessibleName('2 members');
  });
});
