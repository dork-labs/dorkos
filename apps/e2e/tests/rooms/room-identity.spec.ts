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
    await expect(roomsPage.headerMark).toBeVisible();
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

  test('a group message wears the agents it is with, not letters standing in for them', async ({
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
    //
    // **Asked of a GROUP message, because that is the direct message with a row
    // now** (`sidebar-simplification` D2): a one-to-one is the agent's own
    // session under a second name, so Library lists the agent instead. The case
    // below asks the same question of a one-to-one everywhere it still appears.
    const otter = await roomsApi.registerAgent(`E2E Otter ${roomsApi.runId}`, '🦦', '#3b82f6');
    const heron = await roomsApi.registerAgent(`E2E Heron ${roomsApi.runId}`, '🪶', '#a855f7');
    const title = `${otter.name} and ${heron.name}`;
    const room = await roomsApi.createDirectMessage(title, [otter, heron]);
    await openCockpit(basePage);

    const row = roomsPage.rowIn(roomsPage.directMessages, title);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // Read the expected faces off the roster rather than assuming the order
    // they were seeded in — the store answers oldest-first with the author id
    // breaking a seeded roster's tie, which is not the seeding order.
    const roster = await roomsApi.getRoom(room.id);
    const agentEmoji = roster.members
      .filter((member) => member.author.kind === 'agent')
      .map((member) => member.author.emoji);
    expect(agentEmoji.every(Boolean), 'every agent on the roster carries an emoji').toBe(true);
    await expect(roomsPage.rowMark(title)).toHaveText(agentEmoji.join(''));
    // What a person actually reads across that row: the faces, then the name.
    // A letter disc renders "E E2E Otter and …" here and fails. Joined with a
    // space rather than nothing — each face in the stack is its own element, and
    // `visibleText` reads one text node at a time.
    expect(await visibleText(row)).toBe(`${agentEmoji.join(' ')} ${title}`);

    // The same faces in the open room's masthead and on its roster.
    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.roomHeading).toHaveAccessibleName(title, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.headerMark).toHaveText(agentEmoji.join(''));
    await expect(roomsPage.memberList).toHaveAccessibleName(`Members of ${title}, 3 members`);
    for (const agent of [otter, heron]) {
      const disc = roomsPage.memberList
        .locator('[data-slot="room-member-avatar"]')
        .filter({ hasText: agent.name });
      expect(await visibleText(disc)).toBe(agent.emoji);
    }
  });

  test('a one-to-one still wears its agent wherever it is drawn, having left the sidebar', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    // The suppression is about WHERE a one-to-one is listed, never about what it
    // looks like (`sidebar-simplification` D2). So the identity question stands,
    // asked where the room is still drawn: its masthead and its roster. A rule
    // that hid the row AND broke the face would pass a test that only checked
    // the row was gone.
    const otter = await roomsApi.registerAgent(`E2E Solo Otter ${roomsApi.runId}`, '🦦', '#3b82f6');
    const room = await roomsApi.createDirectMessage(otter.name, [otter]);
    await openCockpit(basePage);

    // No row: the agent's own row is the one door to it.
    await expect(roomsPage.rowIn(roomsPage.directMessages, otter.name)).toHaveCount(0);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.roomHeading).toHaveAccessibleName(otter.name, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.headerMark).toHaveText(otter.emoji);
    await expect(roomsPage.memberList).toHaveAccessibleName(`Members of ${otter.name}, 2 members`);
    const disc = roomsPage.memberList
      .locator('[data-slot="room-member-avatar"]')
      .filter({ hasText: otter.name });
    expect(await visibleText(disc)).toBe(otter.emoji);
  });
});
