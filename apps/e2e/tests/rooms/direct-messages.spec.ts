import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import { visibleText } from '../../pages/RoomsPage';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from './open-cockpit';

/** The room id in the address bar, which is what "the conversation on screen" means. */
function openRoomId(page: Page): string {
  const id = new URL(page.url()).searchParams.get('id');
  if (!id) throw new Error(`No room is open: ${page.url()}`);
  return id;
}

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
 * One door to an agent: picking one opens its session, picking several starts a
 * group message (`sidebar-simplification` D2).
 *
 * A one-to-one direct message used to be the other thing this picker made, and
 * it was the agent's own session under a second name — same agent, same working
 * directory, and a log holding the agent's final words and none of its work. So
 * one agent now goes where its sidebar row goes, and a room is what two or more
 * make.
 *
 * The picker is still multi-select and still hides nobody: the duplicate
 * guarantee lives on the server, which matches a direct message on its exact
 * member set (spec `rooms` §12.3).
 *
 * The keyboard is the whole interaction, and every bug this picker has had was
 * two of Enter's three meanings collapsing into each other. The one that shipped
 * is here: a query nobody matched opened the half-assembled conversation, so
 * typing `Kia` for Kai and pressing Enter to try again threw the rest away.
 *
 * No Claude SDK or API key: every seeded agent is `silent`, so a conversation
 * opened here triggers nobody.
 */
test.describe('Rooms — starting a direct message @smoke', () => {
  test('picking one agent opens that agent’s session, not a second conversation', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    await openCockpit(basePage);

    await roomsPage.openDirectMessagePicker();
    // The rule is stated before the button changes its words.
    await expect(
      page.getByText('One agent opens a session. Two or more start a group message.')
    ).toBeVisible();
    await roomsPage.chooseAgent(ana.name);
    await expect(roomsPage.agentChip(ana.name)).toBeVisible();
    // One agent is one door: the agent's own session, exactly where its sidebar
    // row goes.
    await expect(roomsPage.startConversationButton).toHaveText(`Open session with ${ana.name}`);
    await roomsPage.startConversationButton.click();

    await expect(page).toHaveURL(/\/session\?.*dir=/, { timeout: SERVER_ROUND_TRIP_MS });
    // And no second conversation was made anywhere: nothing landed in Direct
    // messages, and nothing landed in Channels either.
    await expect(roomsPage.rowIn(roomsPage.directMessages, ana.name)).toHaveCount(0);
    await expect(roomsPage.rowIn(roomsPage.channels, ana.name)).toHaveCount(0);
  });

  test('picking several agents opens one group message holding all of them', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const kai = await roomsApi.registerAgent(`E2E Kai ${roomsApi.runId}`, '🦉', '#5b8def');
    await openCockpit(basePage);

    await roomsPage.openDirectMessagePicker();
    await roomsPage.chooseAgent(ana.name);
    // Nothing is filtered out, but an agent already chosen leaves the list —
    // it is standing in the chip row instead.
    await roomsPage.chooseAgent(kai.name);
    await expect(roomsPage.agentChip(ana.name)).toBeVisible();
    await expect(roomsPage.agentChip(kai.name)).toBeVisible();
    // Two agents make it a group message, and the action changes to say so.
    await expect(roomsPage.startConversationButton).toHaveText('Start group message');
    await roomsPage.startConversationButton.click();

    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    const roomId = openRoomId(page);
    roomsApi.track(roomId);

    // Titled from the participants, and holding every one of them plus you.
    const title = `${ana.name} and ${kai.name}`;
    await expect(roomsPage.roomHeading).toHaveAccessibleName(title, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    // You plus both agents. The roster is a head count in the bar now, not a row
    // of discs — each agent's own face is proven on the sidebar row just below.
    await expect(roomsPage.membersChip).toHaveAccessibleName('3 members');

    // A group's mark stacks its agents' faces rather than standing in for them
    // with one, in roster order. Read the expected faces from the roster itself
    // rather than assuming the order they were picked in.
    //
    // `RoomAvatar` stacks at most three (`MAX_STACKED_FACES`), so joining every
    // agent on the roster is only the right expectation while this DM has three
    // or fewer — it seeds two. A fourth agent here would need the cap applied.
    const roster = await roomsApi.getRoom(roomId);
    const agentEmoji = roster.members
      .filter((m) => m.author.kind === 'agent')
      .map((m) => m.author.emoji);
    expect(agentEmoji.every(Boolean), 'every agent on the roster carries an emoji').toBe(true);
    await expect(roomsPage.rowIn(roomsPage.directMessages, title)).toHaveCount(1, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.rowMark(title)).toHaveText(agentEmoji.join(''));

    // And each agent wears its own face on its roster row in the room panel —
    // the discs that went with the masthead in phase R1, back one press away in
    // phase R2. Asserted per agent rather than as a stack: this is the list
    // where "who exactly" is the question being answered.
    await roomsPage.openRoomPanel();
    await expect(roomsPage.memberFace(ana.name)).toHaveText(ana.emoji, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.memberFace(kai.name)).toHaveText(kai.emoji);
  });

  test('a query nobody matches does not open the half-assembled conversation', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const kai = await roomsApi.registerAgent(`E2E Kai ${roomsApi.runId}`, '🦉', '#5b8def');
    await openCockpit(basePage);

    await roomsPage.openDirectMessagePicker();
    await roomsPage.chooseAgent(ana.name);
    const before = page.url();

    // Reaching for the second agent and mistyping its name. Enter here used to
    // open the conversation with only the first agent in it and throw the rest
    // of the intent away — the exact "Kia for Kai" case.
    await roomsPage.agentSearch.fill(`${kai.name}xx`);
    await expect(roomsPage.agentOptions).toHaveCount(0);
    await expect(page.getByText('No agent by that name.')).toBeVisible();
    await roomsPage.agentSearch.press('Enter');
    expect(page.url()).toBe(before);

    // The picker is still open with the work so far intact, which is what makes
    // correcting the typo possible at all. Under the defect the popover has
    // closed by now and this line has nothing to type into.
    await expect(roomsPage.agentChip(ana.name)).toBeVisible();
    await roomsPage.chooseAgent(kai.name);
    await roomsPage.startConversationButton.click();

    // The conversation that opens is the one that was asked for — both agents.
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    roomsApi.track(openRoomId(page));
    const title = `${ana.name} and ${kai.name}`;
    await expect(roomsPage.roomHeading).toHaveAccessibleName(title, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.membersChip).toHaveAccessibleName('3 members');
    // And no one-to-one with the first agent was left behind by the stray Enter.
    await expect(roomsPage.rowIn(roomsPage.directMessages, ana.name)).toHaveCount(0);
  });

  test('asking for the same people again opens the conversation you already have', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const kai = await roomsApi.registerAgent(`E2E Kai ${roomsApi.runId}`, '🦉', '#5b8def');
    await openCockpit(basePage);

    await roomsPage.openDirectMessagePicker();
    await roomsPage.chooseAgent(ana.name);
    await roomsPage.chooseAgent(kai.name);
    await roomsPage.startConversationButton.click();
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    const first = openRoomId(page);
    roomsApi.track(first);

    // Navigate away so the second open is a real navigation rather than a no-op.
    await page.goto('/channels');
    await expect(page.getByText('Pick a conversation')).toBeVisible();

    // The picker never hides an agent that already has a conversation — that
    // filter was how duplicates were prevented, and it had to go so a group
    // could include somebody you already talk to.
    await roomsPage.openDirectMessagePicker();
    await expect(roomsPage.agentOptions.filter({ hasText: ana.name })).toHaveCount(1);
    await roomsPage.chooseAgent(ana.name);
    await roomsPage.chooseAgent(kai.name);
    await roomsPage.startConversationButton.click();

    // Same people, same conversation — matched on the member set by the server.
    await expect(page).toHaveURL(new RegExp(`id=${first}`), { timeout: SERVER_ROUND_TRIP_MS });
    expect(openRoomId(page)).toBe(first);
    const title = `${ana.name} and ${kai.name}`;
    await expect(roomsPage.rowIn(roomsPage.directMessages, title)).toHaveCount(1);
  });
});
