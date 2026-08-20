import { test, expect } from '../../fixtures';
import {
  SERVER_ROUND_TRIP_MS,
  type TeamRoomApi,
  type TeamRoomEntry,
} from '../../fixtures/team-room-api';
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

/**
 * Wait for a message this test just typed to be stored, and answer with the
 * cascade it opened.
 *
 * Two barriers in one, both of them things a test that skipped them was flaky
 * about (DOR-1213):
 *
 * - **It is stored.** The composer's Enter is a 202; the entry exists a moment
 *   later. Reading the room before it does gets a room without the message in
 *   it.
 * - **It has a cascade to scope by.** Every assertion downstream is about who
 *   answered THIS message, and #team is shared with every other test on this
 *   leg — see {@link TeamRoomEntry.cascadeRoot}.
 *
 * @param teamRoomApi - The #team fixture.
 * @param said - The exact text that was typed.
 * @param before - The room as it stood before typing, so a neighbour's identical
 *   text cannot be mistaken for this one.
 */
async function postedHere(
  teamRoomApi: TeamRoomApi,
  said: string,
  before: TeamRoomEntry[]
): Promise<string> {
  const stored = await teamRoomApi.waitForEntry(
    (entry) => entry.body.text === said && !before.some((e) => e.id === entry.id),
    `the post "${said}" to be stored`
  );
  return stored.find((entry) => entry.body.text === said && !before.some((e) => e.id === entry.id))!
    .cascadeRoot;
}

/**
 * Milestones, and they must come FIRST in this file.
 *
 * #team marks at most one moment an hour (`MOMENT_QUIET_PERIOD_MS`), which is
 * the etiquette rule that stops an afternoon of setting things up from filling
 * the feed. It also means the first agent created on this leg is the only one
 * whose milestone can land during a run — so this block runs before every other
 * test here that registers an agent, and the first assertion says so out loud
 * rather than letting a later reader wonder why the order matters.
 *
 * The suppression is not just a constraint to work around: the second half of
 * the test below turns it into the claim it is.
 */
test.describe('The moments #team marks @smoke', () => {
  /**
   * A moment this same test minted on an earlier attempt, which is the one
   * reason for #team to already hold one that is nobody's mistake.
   *
   * The names are this block's own and no other test's: every other test here
   * seeds `Tangerine`, `Mango` or `Quiet<a|b>` followed by a hex run id, and no
   * hex digit is `s`, so neither prefix can be reached by them.
   */
  const OURS = /\b(Tangerines|Mangoes)[0-9a-f]{8}\b/;

  test('an agent joining is marked once, as a moment rather than as a message', async ({
    page,
    basePage,
    teamRoomApi,
  }) => {
    // **The quiet period makes this test un-repeatable, and that is the
    // product working** (DOR-1213). #team marks at most one moment an hour, so a
    // second attempt on the same leg — `--repeat-each`, a Playwright retry —
    // creates its agent, is correctly suppressed, and used to fail on the
    // precondition below as if the ordering rule had been broken.
    //
    // So the two cases are told apart rather than merged. A moment this block
    // minted before is a skip; a moment anything ELSE minted is still the loud
    // failure it was, because that one really does mean a test registering an
    // agent ran ahead of this file's first block.
    const already = await teamRoomApi.moments();
    test.skip(
      already.length > 0 && already.every((entry) => OURS.test(entry.body.text ?? '')),
      'this block already marked its moment on this leg, and #team marks at most one an hour'
    );
    expect(
      already,
      'this leg has already marked a moment, so the hour-long quiet period will swallow this one — ' +
        'this block has to run before anything else in this file registers an agent'
    ).toHaveLength(0);

    const name = `Tangerines${teamRoomApi.runId}`;
    const agent = await teamRoomApi.createAgent(name);
    await teamRoomApi.waitForMember(name);

    const entries = await teamRoomApi.waitForEntry(
      (entry) => entry.body.moment !== undefined,
      `a moment marking ${name} joining`
    );
    const marked = entries.filter((entry) => entry.body.moment !== undefined);
    expect(marked).toHaveLength(1);
    const moment = marked[0]!.body.moment!;

    // The words a person reads, and the record they were read off. Asserting
    // both is the point: a milestone that named the agent but pointed at
    // nothing would be the invented moment this whole feature refuses to post.
    expect(marked[0]!.body.text).toContain(name);
    expect(marked[0]!.body.text).toContain('joined your team');
    expect(moment.source).toMatchObject({ kind: 'agent', ref: agent.path });
    expect(moment.mintedByAgentRef, 'the install observed this, no agent claimed it').toBeNull();

    await basePage.goto();
    await basePage.waitForAppReady();

    // A moment is a POST — nothing but its body says so — so what proves the
    // feed told them apart is that this row rendered as a moment at all.
    const row = page.getByTestId('room-moment').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // The kind the SERVER recorded, not one this test decided: an install whose
    // first agent this is says `first_agent` and a later one says `joined_team`,
    // and either way the row must carry what the record says.
    await expect(row).toHaveAttribute('data-moment', moment.kind);
    await expect(row.getByTestId('room-moment-mark')).toBeVisible();
    // Named as a milestone before it is read out — the one piece of context a
    // reader who cannot see the band would otherwise be missing.
    await expect(row).toHaveAttribute('aria-label', new RegExp(`^Moment: .*${name}`));
    // The face is the agent's, not the system's: the line is about them.
    await expect(row.getByTestId('room-moment-identity')).toContainText(name);
    // Nothing to press. A milestone states something that happened and there is
    // nobody to answer, so a control on it would make it read as somebody
    // talking.
    await expect(row.getByRole('button')).toHaveCount(0);

    // And the burst rule, stated positively: a second agent in the same minute
    // is seated, is in the room, and does NOT get a line of its own.
    const second = `Mangoes${teamRoomApi.runId}`;
    await teamRoomApi.createAgent(second);
    await teamRoomApi.waitForMember(second);
    // A real settle rather than a poll, because the claim is an absence: the
    // detector pass runs on the same seam that just seated this agent (the
    // statement straight after it), so a second later is long past the moment
    // it would have posted in.
    await page.waitForTimeout(1000);
    expect(
      (await teamRoomApi.moments()).map((entry) => entry.body.text),
      'a burst of agent creations produced a burst of milestones'
    ).toHaveLength(1);
  });
});

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
    // panel is offered, which is the home surface alone (`ChannelComposer`), and
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
    // **"Nobody else piles on" is a claim about a room with ONE seat set to
    // answer everything** (DOR-1213). The seat moves — `syncDefaultAgent`
    // re-points it every time an agent is created — and on a leg where this
    // file has already run once, more than one membership can be left holding
    // it. Two `always` seats answering an unaddressed post is the product
    // working, so this is read and reported rather than asserted into a red.
    const answering = await teamRoomApi.seatsThatAnswerEverything();
    test.skip(
      answering.length > 1,
      `#team has ${answering.length} seats set to answer everything (${answering.join(', ')}), ` +
        `so more than one answer here is correct and this claim is not about this room`
    );
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
    const root = await postedHere(teamRoomApi, said, before);
    await teamRoomApi.waitForEntry(
      (entry) => entry.authorId === team.fallbackSeatAuthorId && entry.cascadeRoot === root,
      `an answer from the fallback seat to "${said}"`
    );
    // **Then wait for the room to go quiet before counting.** Snapshotting on
    // the first answer cannot see a second one still being written, so a test
    // that counted there would PASS when another agent piled on — it looked too
    // early. `settle` posts a marker, waits for its answer, and then waits for
    // the room's working count to reach zero.
    await teamRoomApi.settle();
    const settled = await teamRoomApi.entries();

    // Exactly ONE agent answered — the stand-down guarantee stated positively.
    //
    // Two filters, and both were flakes (DOR-1213). **The cascade** is what
    // makes this sound on a room every other test on this leg is also posting
    // into: counting entries-not-seen-before instead swept up a neighbour's
    // still-arriving reply and blamed it on this message. **The notice** is what
    // makes it a claim about AGENTS: an agent this file registered in an earlier
    // run leaves an `engaged` seat behind in #team when it is unregistered, and
    // the room says so in this cascade ("… isn't set up on this machine any
    // more, so it can't answer here"). That line is the room being helpful, not
    // a second agent piling on, and counting it reported the opposite.
    const answers = settled.filter(
      (entry) =>
        entry.cascadeRoot === root && entry.body.text !== said && entry.body.notice === undefined
    );
    expect(
      answers.map((entry) => entry.authorId),
      `more than one agent answered a post that addressed nobody. ` +
        `In this cascade: ${answers.map((e) => `${e.authorId}=${e.body.text}`).join(' | ')}. ` +
        `Seats set to answer everything: ${answering.join(', ')}. ` +
        `Roster: ${(await teamRoomApi.roster()).join(', ')}`
    ).toHaveLength(1);

    // And the reader sees it, not just the database.
    await expect(page.getByTestId('room-timeline')).toContainText(said, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });

  test('saying something here puts #team in Today (DOR-1156)', async ({
    basePage,
    homeSurface,
    dashboardSidebar,
    teamRoomApi,
    page,
  }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    // **Home is arrived at, not opened.** `/` renders #team, but the router
    // reports no conversational target there — so the room gets no anchor row
    // and no interaction record, and this browser has never clicked it in the
    // sidebar either. Today genuinely does not have it.
    const teamRow = dashboardSidebar.todayRows.filter({ hasText: 'team' });
    await expect(teamRow).toHaveCount(0);

    const said = `today check ${teamRoomApi.runId}`;
    await homeSurface.composerField.click();
    await homeSurface.composerField.fill(said);
    await homeSurface.composerField.press('Enter');

    // The post lands…
    await expect(page.getByTestId('room-timeline')).toContainText(said, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    // …and the room the operator wrote in is now one of the places they have
    // been today. Deleting the write in the room target's `send` reddens
    // exactly this line.
    await expect(teamRow).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
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

    // **The mention has to have RESOLVED before who-answered means anything**
    // (DOR-1213). `@name` leaves the composer as plain text; the server turns it
    // into a mention, and if the handle was not addressable yet it resolves to
    // nobody — at which point the fallback seat answering is CORRECT and this
    // test would report a working product as broken. `waitForMember` now waits
    // for the handle too, so this is a check rather than a wait; it stays
    // because it is the assertion that names the cause when it does not hold.
    const root = await postedHere(teamRoomApi, said, before);
    expect(
      (await teamRoomApi.entries()).find((entry) => entry.cascadeRoot === root)?.mentions,
      `"${said}" reached the room addressing nobody, so nothing here is about standing down`
    ).toContain(tangerineId);

    await teamRoomApi.waitForEntry(
      (entry) => entry.authorId === tangerineId && entry.cascadeRoot === root,
      `an answer from ${name}`
    );
    // The named agent answering is not proof the default agent stayed out of it
    // — the fallback seat's own turn could still be in flight. So the room is
    // taken to quiet first, and only then counted (DOR-1213).
    await teamRoomApi.settle();
    const after = await teamRoomApi.entries();

    // The whole point of D3.4's second half: the named agent answers and the
    // fallback seat does NOT, so a room with ten agents in it costs one turn.
    // Scoped to this post's cascade — a neighbour's reply, still arriving from
    // the test before this one, is not an answer to this message.
    expect(
      after.filter(
        (entry) => entry.cascadeRoot === root && entry.authorId === team.fallbackSeatAuthorId
      ),
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

    // This file drives real turns for real, earlier in this same serial run —
    // "typing here reaches your default agent", for one — and each one earns a
    // genuine, correct Shift Report the moment its composer next runs. This
    // test is about approvals, asks and attention, not about the report, so it
    // starts from an operator who has already seen today's, exactly as a real
    // one would have by now (`markAllNotificationsRead`'s own doc explains why
    // this is a fixture reset, not a product action under test).
    await teamRoomApi.markAllNotificationsRead();

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

test.describe("DorkBot's one quiet suggestion @smoke", () => {
  test('a caught-up quiet room says two words and offers one thing, once', async ({
    page,
    basePage,
    teamRoomApi,
  }) => {
    // Two preconditions about state this test shares with the whole leg, read
    // rather than assumed. Each one is a case where the quiet line is CORRECT to
    // stand down, so failing on them would report a working product as broken.
    const waiting = await teamRoomApi.pendingApprovalIds();
    test.skip(waiting.length > 0, 'something else on this server is waiting on a person');
    const unreachable = await teamRoomApi.meshUnreachableCount();
    test.skip(unreachable > 0, 'an agent is unreachable, so the header has something to say');

    // A THIRD case where the header is correct to have something to say: a
    // real turn earlier in this same serial run earned a genuine Shift Report
    // (`markAllNotificationsRead`'s own doc explains why). "All quiet." and an
    // unread report are mutually exclusive by this widget's own design
    // (`HomeQuietState`'s `headerSpeaks`), so a suggestion test that wants the
    // quiet line has to start from an operator who has already seen it.
    await teamRoomApi.markAllNotificationsRead();

    // The suggestion has to be EARNED — the registry's own rules decide, and the
    // one that can qualify here wants more than one agent in the mesh. Seeded
    // rather than hoped for: every other test in this file puts its agents away
    // at teardown.
    for (const suffix of ['a', 'b']) {
      await teamRoomApi.createAgent(`Quiet${suffix}${teamRoomApi.runId}`);
    }
    await expect
      .poll(() => teamRoomApi.registeredAgentCount(), { timeout: SERVER_ROUND_TRIP_MS })
      .toBeGreaterThanOrEqual(2);

    // First visit reads the room to the end. "All quiet." is a claim about right
    // now, measured against the cursor as it stood when the page opened, so the
    // reader has to have caught up on a PREVIOUS visit for it to be true.
    await basePage.goto();
    await basePage.waitForAppReady();
    await expect(page.getByTestId('room-timeline')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    const newest = (await teamRoomApi.entries()).at(-1)?.seq ?? 0;
    await expect
      .poll(() => teamRoomApi.readCursorSeq(), { timeout: SERVER_ROUND_TRIP_MS })
      .toBeGreaterThanOrEqual(newest);

    // Coming back to a room with nothing new in it — the one arrangement that
    // draws the line at all.
    await page.reload();
    await basePage.waitForAppReady();
    const quiet = page.locator('[data-slot="home-quiet-state"]');
    await expect(quiet).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(quiet).toContainText('All quiet.');

    // ONE suggestion, never a list: a quiet morning that answers with a menu is
    // not a quiet morning.
    const suggestion = quiet.locator('[data-slot="quiet-suggestion"]');
    await expect(suggestion).toHaveCount(1);
    const dismiss = suggestion.getByRole('button', { name: /^Dismiss suggestion: / });
    await expect(dismiss).toBeVisible();

    // Waving it away is one press, and it is remembered: the same suggestion
    // does not come back the next morning.
    await dismiss.click();
    await expect(suggestion).toHaveCount(0);
    // The line above it stays — dismissing the offer is not dismissing the news.
    await expect(quiet).toContainText('All quiet.');

    await page.reload();
    await basePage.waitForAppReady();
    await expect(quiet).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(quiet.locator('[data-slot="quiet-suggestion"]')).toHaveCount(0);
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
