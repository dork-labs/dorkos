import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/team-room-api';
import { publishSessionStreaming, tapGlobalStream } from '../rooms/room-signals';

/**
 * Home is the #team room (spec `team-room-home`, Phase 2).
 *
 * The dashboard is gone. `/` renders one real room through the same machinery
 * `/channels` uses, with the two things that can interrupt a person pinned above
 * the feed. Phase 1's shell spec (`home-shell.spec.ts`) already proves the tab
 * bar and the sidebar; this file proves the room.
 *
 * ## Why this project runs against the TEST-MODE leg
 *
 * Two of these claims are about an agent ANSWERING, which needs a runtime that
 * replies. That alone would be reason enough. The harder reason is that posting
 * into #team on the cockpit leg would be **actively unsafe**: DorkBot holds the
 * `always` seat there, its manifest names `claude-code`, and the cockpit leg
 * registers the real Claude Code runtime — so a single `Enter` in this composer
 * starts a real turn against whatever `claude` sign-in the machine has, and
 * bills it. There is no key to withhold that prevents that (AGENTS.md,
 * "One test in the repo spends real money", makes the same point about the
 * evals harness). The test-mode leg registers a `claude-code`-typed
 * `TestModeRuntime` alias, so DorkBot answers there for free and
 * deterministically.
 *
 * ## What this suite may and may not assume
 *
 * #team is **not a room a test creates**. The server opens exactly one per
 * install and refuses to delete it, so every test here shares it with every
 * other test on this leg and with its own neighbours. That rules out any
 * assertion phrased as a claim about the whole room — "the feed holds one
 * message", "nobody has posted" — for the reason GOTCHAS gives about the rest of
 * the suite. Each test therefore writes text carrying its own run id and asserts
 * only on that.
 *
 * Serial, and deliberately: one of these archives the shared room, which changes
 * what `/` renders for every page on this server until it is restored.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

test.describe('Home is the #team room @smoke', () => {
  test('`/` opens the room: its masthead, its feed, its composer', async ({
    page,
    basePage,
    homeSurface,
    roomsPage,
    teamRoomApi,
  }) => {
    const team = await teamRoomApi.teamRoom();
    expect(team.archived, 'another test left #team archived').toBe(false);

    await basePage.goto();
    await basePage.waitForAppReady();

    // The masthead is the room's, not a page title: home is addressed by a
    // well-known key, so what proves it resolved is the room's own chrome.
    await expect(roomsPage.roomHeading).toContainText('team', { timeout: SERVER_ROUND_TRIP_MS });
    await expect(homeSurface.composerField).toHaveAttribute('placeholder', /#team/);

    // The feed is the ROOM's — `room-timeline` only exists once something has
    // been said, so what is asserted here is the surface that is always there.
    // A room with nothing in it says so; it does not draw a dashboard.
    await expect(page.getByRole('heading', { name: /your agents/i })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /system status/i })).toHaveCount(0);

    // And it is the SAME widget under the alias, not a second copy. Both
    // addresses draw ONE room masthead; a fork would draw two trees, and the
    // count is what says which happened.
    await page.goto(`/channels?id=${team.id}`);
    await basePage.waitForAppReady();
    await expect(roomsPage.roomHeading).toContainText('team', { timeout: SERVER_ROUND_TRIP_MS });
    // ONE masthead, not two: the sidebar also draws a `room-title` for the
    // channel row, so the count that means "one room tree" is the masthead's.
    await expect(roomsPage.roomHeader).toHaveCount(1);
    // The room's composer, addressed the way every other room spec addresses
    // it. Not `home-composer`: that testid is stamped only where the recents
    // panel is offered, which is the home surface alone (`RoomComposer`), and
    // its absence here is the correct answer rather than a missing composer.
    await expect(roomsPage.composer('#team')).toBeVisible();
  });

  test('typing here reaches your default agent, and nobody else piles on', async ({
    basePage,
    homeSurface,
    teamRoomApi,
    page,
  }) => {
    const team = await teamRoomApi.teamRoom();
    expect(
      team.fallbackSeatAuthorId,
      'no agent holds the fallback seat, so nothing can answer an unaddressed post'
    ).toBeTruthy();
    const before = await teamRoomApi.entries();

    await basePage.goto();
    await basePage.waitForAppReady();

    const said = `deploy check ${teamRoomApi.runId}`;
    await homeSurface.composerField.click();
    await homeSurface.composerField.fill(said);
    await homeSurface.composerField.press('Enter');

    // The post lands, and the page does not move: this is a room post, not the
    // birth of a session. The old dashboard composer navigated away from itself.
    await expect(page).toHaveURL(/\/(\?|$)/);
    const withReply = await teamRoomApi.waitForEntry(
      (entry) =>
        entry.authorId === team.fallbackSeatAuthorId && !before.some((e) => e.id === entry.id),
      `an answer from the fallback seat to "${said}"`
    );

    // Exactly ONE agent answered — the stand-down guarantee stated positively.
    // Counting new agent entries rather than all of them is what makes this
    // sound on a room a neighbouring test also posted into.
    const mine = withReply.filter((entry) => !before.some((e) => e.id === entry.id));
    const answers = mine.filter((entry) => entry.authorId !== mine[0]?.authorId);
    expect(
      answers.map((entry) => entry.authorId),
      'more than one agent answered a post that addressed nobody'
    ).toHaveLength(1);

    // And the reader sees it, not just the database.
    await expect(page.getByTestId('room-timeline')).toContainText(said, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });

  test('naming an agent stands the default agent down', async ({
    basePage,
    homeSurface,
    teamRoomApi,
  }) => {
    const team = await teamRoomApi.teamRoom();
    const name = `Tangerine${teamRoomApi.runId}`;
    await teamRoomApi.createAgent(name);
    const tangerineId = await teamRoomApi.waitForMember(name);
    const before = await teamRoomApi.entries();

    await basePage.goto();
    await basePage.waitForAppReady();

    const said = `@${name.toLowerCase()} look at the build ${teamRoomApi.runId}`;
    await homeSurface.composerField.click();
    await homeSurface.composerField.fill(said);
    await homeSurface.composerField.press('Enter');

    const after = await teamRoomApi.waitForEntry(
      (entry) => entry.authorId === tangerineId && !before.some((e) => e.id === entry.id),
      `an answer from ${name}`
    );

    // The whole point of D3.4's second half: the named agent answers and the
    // fallback seat does NOT, so a room with ten agents in it costs one turn.
    const mine = after.filter((entry) => !before.some((e) => e.id === entry.id));
    expect(
      mine.filter((entry) => entry.authorId === team.fallbackSeatAuthorId),
      'the default agent answered a post that named somebody else'
    ).toHaveLength(0);
  });
});

test.describe('The pinned triage header @smoke', () => {
  test('nothing waiting draws nothing — no empty box, no border', async ({
    page,
    basePage,
    teamRoomApi,
  }) => {
    // Only sound while nothing else is waiting. The queue is server-global, so
    // this reads it first and says so rather than failing as if the header broke.
    const waiting = await teamRoomApi.pendingApprovalIds();
    test.skip(waiting.length > 0, 'something else on this server is waiting on a person');

    await basePage.goto();
    await basePage.waitForAppReady();
    await expect(page.getByTestId('home-composer')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // A count of zero, not a hidden class: an element that is merely `hidden`
    // still matches, and "collapses away entirely" is the claim.
    await expect(page.locator('[data-slot="pinned-triage-header"]')).toHaveCount(0);
    // The live region stays, and stays empty — a region added at the same moment
    // as its words is unreliably announced.
    await expect(page.locator('[role="status"][aria-live="polite"]').first()).toBeAttached();
  });

  test('an approval can be answered from home, and the card resolves where it stands', async ({
    page,
    basePage,
    teamRoomApi,
  }) => {
    const approvalId = await teamRoomApi.seedApproval();
    await basePage.goto();
    await basePage.waitForAppReady();

    const header = page.locator('[data-slot="pinned-triage-header"]');
    await expect(header).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(header.getByRole('heading', { name: /waiting on you/i })).toBeVisible();

    const card = header.locator('[data-slot="approval-card"]').first();
    const before = await header.locator('[data-slot="approval-card"]').count();
    await card.locator('[data-slot="approval-allow"]').click();

    // Answered IN PLACE: the checkmark replaces the buttons on the card that is
    // still standing, and only then does the card leave. Asserting the
    // checkmark BEFORE the count drop is what distinguishes "resolves in place"
    // from "vanishes on click".
    await expect(header.locator('[data-slot="approval-resolved"]').first()).toBeVisible();
    await expect(header.locator('[data-slot="approval-card"]')).toHaveCount(before - 1, {
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // The decision reached the server, not just the DOM.
    await expect
      .poll(() => teamRoomApi.pendingApprovalIds(), { timeout: SERVER_ROUND_TRIP_MS })
      .not.toContain(approvalId);

    // The feed never moved: nothing navigated, and the room is still under it.
    await expect(page).toHaveURL(/\/(\?|$)/);
    await expect(page.getByTestId('home-composer')).toBeVisible();
  });

  test('an attention deep link still opens its sheet on /', async ({ page, basePage }) => {
    // The three detail sheets moved into the header with the rows that open
    // them, so `/?detail=…` has to keep working — it is a URL somebody pasted.
    await page.goto('/?detail=offline-agent');
    await basePage.waitForAppReady();
    await expect(page.getByRole('dialog').getByText('Offline Agents')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });
});

test.describe('The presence strip @smoke', () => {
  test('somebody working elsewhere shows up, and clicking follows them', async ({
    page,
    basePage,
    teamRoomApi,
  }) => {
    // An agent to be working. Created through the seam that also seats it in
    // #team, because the strip resolves a working session by its working
    // DIRECTORY — an agent the mesh does not know maps to nobody and the strip
    // omits it rather than inventing a name.
    const name = `Mango${teamRoomApi.runId}`;
    const agent = await teamRoomApi.createAgent(name);
    await teamRoomApi.waitForMember(name);

    // The signal itself is the test's, injected onto the REAL global stream —
    // the same trade `room-signals.ts` documents at length. Producing one for
    // real means a turn that lasts long enough to photograph, which buys
    // fidelity with flake. What is real here is everything downstream: the
    // frame decoder, the session-list store, the row builder, the strip.
    await tapGlobalStream(page);
    await basePage.goto();
    await basePage.waitForAppReady();
    await expect(page.getByTestId('home-composer')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    const sessionId = `4f6c1b2a-0000-4000-8000-${teamRoomApi.runId.padEnd(12, '0').slice(0, 12)}`;
    await publishSessionStreaming(page, { sessionId, cwd: agent.path });

    const strip = page.getByTestId('presence-strip');
    await expect(strip).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(strip).toContainText(name);

    // Clicking WATCHES. The row's accessible name is the promise — "Watch", not
    // "Open" or "Take over" — and following must land on the work without
    // claiming it. That the follow does not acquire the session lock is pinned
    // where it can be counted (`use-presence-strip.test.tsx` asserts zero
    // control invocations); what a browser can add is that the promise on the
    // control matches where it goes.
    const row = strip.getByRole('button', { name: new RegExp(`^Watch ${name}`) });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(new RegExp(`session=${sessionId}`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });
});

test.describe('When #team is put away @smoke', () => {
  // Serial and alone: while this runs, `/` shows the restore notice on every
  // page this server is serving.
  test.describe.configure({ mode: 'serial' });

  test('home offers to bring it back, and does not do it behind your back', async ({
    page,
    basePage,
    teamRoomApi,
  }) => {
    await teamRoomApi.archiveTeamRoom();
    await basePage.goto();
    await basePage.waitForAppReady();

    // The notice, not a half-built room and not a silent un-archive.
    await expect(page.getByText(/is archived/)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // No half-built room behind the notice: the composer is the thing you would
    // have typed into, and it is not there.
    await expect(page.getByTestId('home-composer')).toHaveCount(0);
    expect(await teamRoomApi.isArchived(), 'home un-archived the room by itself').toBe(true);

    await page.getByRole('button', { name: 'Bring it back' }).click();

    // One press brings the room back, and the conversation is there.
    await expect(page.getByTestId('home-composer')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    expect(await teamRoomApi.isArchived()).toBe(false);
  });
});
