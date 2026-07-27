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
 * Starting a direct message: one agent, or several at once.
 *
 * The picker used to be single-select, and it hid every agent that already had a
 * conversation — which was how a duplicate one-to-one was prevented, and which
 * became wrong the moment a conversation could hold several agents, because Ana
 * alone and Ana + Kai are different conversations (spec `rooms` §12.3). The
 * guarantee moved to the server, which matches a direct message on its exact
 * member set.
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
  test.beforeEach(async ({ roomsApi }) => {
    await roomsApi.dismissOnboarding();
  });

  test('picking one agent opens a one-to-one wearing that agent', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    await openCockpit(basePage);

    await roomsPage.openDirectMessagePicker();
    await roomsPage.chooseAgent(ana.name);
    await expect(roomsPage.agentChip(ana.name)).toBeVisible();
    // One agent is a one-to-one, and the action says so.
    await expect(roomsPage.startConversationButton).toHaveText('Start conversation');
    await roomsPage.startConversationButton.click();

    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    roomsApi.track(openRoomId(page));

    // The conversation is named after who is in it, and wears their face.
    await expect(roomsPage.roomHeading).toHaveAccessibleName(ana.name, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.headerMark).toHaveText(ana.emoji);
    await expect(roomsPage.memberList).toHaveAccessibleName('2 members');

    // And it is a direct message, not a channel: the row is in the other section.
    const row = roomsPage.rowIn(roomsPage.directMessages, ana.name);
    await expect(row).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    expect(await visibleText(row)).toBe(`${ana.emoji} ${ana.name}`);
    await expect(roomsPage.rowIn(roomsPage.channels, ana.name)).toHaveCount(0);
  });

  test('picking several agents opens one group conversation holding all of them', async ({
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
    // Two agents make it a group, and the action changes to say so.
    await expect(roomsPage.startConversationButton).toHaveText('Start group conversation');
    await roomsPage.startConversationButton.click();

    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    const roomId = openRoomId(page);
    roomsApi.track(roomId);

    // Titled from the participants, and holding every one of them plus you.
    const title = `${ana.name} and ${kai.name}`;
    await expect(roomsPage.roomHeading).toHaveAccessibleName(title, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.memberList).toHaveAccessibleName('3 members');
    for (const agent of [ana, kai]) {
      const disc = roomsPage.memberList
        .locator('[data-slot="room-member-avatar"]')
        .filter({ hasText: agent.name });
      expect(await visibleText(disc)).toBe(agent.emoji);
    }

    // A group's mark is the first agent on its roster — read from the roster
    // itself rather than assumed from the order they were picked in.
    const roster = await roomsApi.getRoom(roomId);
    const firstAgentEmoji = roster.members.find((m) => m.author.kind === 'agent')?.author.emoji;
    expect(firstAgentEmoji, "the roster's first agent carries an emoji").toBeTruthy();
    await expect(roomsPage.rowIn(roomsPage.directMessages, title)).toHaveCount(1, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.rowMark(title)).toHaveText(firstAgentEmoji ?? '');
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
    await expect(roomsPage.memberList).toHaveAccessibleName('3 members');
    // And no one-to-one with the first agent was left behind by the stray Enter.
    await expect(roomsPage.rowIn(roomsPage.directMessages, ana.name)).toHaveCount(0);
  });

  test('asking for the same agent again opens the conversation you already have', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    await openCockpit(basePage);

    await roomsPage.openDirectMessagePicker();
    await roomsPage.chooseAgent(ana.name);
    await roomsPage.startConversationButton.click();
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    const first = openRoomId(page);
    roomsApi.track(first);

    // Navigate away so the second open is a real navigation rather than a no-op.
    await page.goto('/channels');
    await expect(page.getByText('Pick a conversation')).toBeVisible();

    // The picker no longer hides an agent that already has a conversation —
    // that filter was how duplicates were prevented, and it had to go so a
    // group could include somebody you already talk to on their own.
    await roomsPage.openDirectMessagePicker();
    await expect(roomsPage.agentOptions.filter({ hasText: ana.name })).toHaveCount(1);
    await roomsPage.chooseAgent(ana.name);
    await roomsPage.startConversationButton.click();

    // Same people, same conversation — matched on the member set by the server.
    await expect(page).toHaveURL(new RegExp(`id=${first}`), { timeout: SERVER_ROUND_TRIP_MS });
    expect(openRoomId(page)).toBe(first);
    await expect(roomsPage.rowIn(roomsPage.directMessages, ana.name)).toHaveCount(1);
  });
});
