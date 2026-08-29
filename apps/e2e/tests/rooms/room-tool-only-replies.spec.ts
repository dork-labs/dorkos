import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS, type SeededRoom } from '../../fixtures/rooms-api';

/**
 * What a person SEES when an agent decides for itself whether to speak
 * (spec `tool-only-room-replies`, acceptance criteria 2, 4 and 5; ADR
 * `260829-025020`).
 *
 * Three things, and each is a different shape of room:
 *
 * 1. a tool-only reply lands once, and it is drawn as an answer to the message
 *    that asked;
 * 2. a person asked and got nothing, so the room says one line about it;
 * 3. nobody asked and the turn had nothing to add, so the room is unchanged —
 *    and the working pill goes away rather than spinning.
 *
 * ## What is pinned below the browser, and why these three are not
 *
 * The mechanism is covered heavily elsewhere: twenty-five cases in
 * `room-tool-only-replies.test.ts` over the real service and dispatcher, and six
 * gating structural evals in `packages/evals/src/suite/rooms-tool-only.ts`. What
 * only a browser can add is that a person can SEE the difference — that the
 * answer pointer is drawn on the tool post, that the notice renders as a notice
 * rather than as a message, and that a turn which produces nothing still clears
 * its indicator. All three are DOM facts and none of them is reachable from an
 * API assertion.
 *
 * ## New specs, and the six that already existed are untouched
 *
 * That is the point of D14 and it is a property of the code rather than a
 * promise: `test-mode` reports NOT tool-capable unless the selected scenario
 * opts in, so turning `rooms.toolOnlyReplies` on changes nothing for any
 * scenario that predates it. Every test here opts in explicitly; nothing here
 * edits `room-autonomy.spec.ts` or `team-room.spec.ts`.
 *
 * ## Why the TEST-MODE leg, and why that is a safety property
 *
 * The same argument `room-autonomy.spec.ts` makes, and for the same reason:
 * every test here un-silences an agent, and on the cockpit leg that means a
 * real, billable claude-code turn on whatever `claude` sign-in the machine has.
 * There is no key to withhold that prevents it. {@link requireTestModeLeg} makes
 * that a check rather than a hope.
 *
 * ## How the agent "calls the tool"
 *
 * It does not, and it cannot: a test-mode scenario is handed the message it is
 * answering and nothing else — no room id, no registry. So the scenarios here
 * HOLD the turn open and the TEST makes the call an injected `dorkos` MCP server
 * would make: a real agent token from `POST /api/test/agent-token`, and the real
 * `rooms.post` capability. What is faked is the model's decision to call it;
 * everything downstream of the decision is the shipped path.
 */

/** What `rooms.toolOnlyReplies` ships as, and what this file puts back. */
const TOOL_ONLY_DEFAULT = false;

/** The scenario that holds a turn open and then narrates a line at the end. */
const NARRATING = 'rooms-hold-then-narrate';

/** The scenario that holds a turn open and then ends having said nothing. */
const QUIET = 'rooms-hold-then-quiet';

/**
 * What {@link NARRATING} says back to its own session.
 *
 * Asserted ABSENT rather than merely uncounted: with the flip working this
 * sentence exists only inside the agent's own transcript, and a count of entries
 * would pass on the wrong entry.
 */
const NARRATION = 'I looked at it and here is what I think.';

/**
 * Put the runtime back to a known state, and refuse to run anywhere but the
 * test-mode leg.
 *
 * The same doubled purpose `room-autonomy.spec.ts` gives it: `/api/test/*` is
 * mounted only under `DORKOS_TEST_RUNTIME`, so a 404 means this spec is pointed
 * at the cockpit leg — where the agents it is about to un-silence would answer
 * with a real model on the machine's own sign-in.
 *
 * @param request - The test's API context, proxied to whichever leg it is on.
 */
async function requireTestModeLeg(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/test/reset');
  if (res.status() === 404) {
    throw new Error(
      'This spec is running against a leg with no TestModeRuntime. It un-silences room ' +
        'agents, so on the cockpit leg every test here would start a real, billable ' +
        'claude-code turn. Run it in the `chromium-rooms-agents` project.'
    );
  }
  if (!res.ok()) throw new Error(`Could not reset the test-mode runtime: ${await res.text()}`);
}

/**
 * Install a scenario and prove it took.
 *
 * The read-back is the guard rather than politeness: the scenario store is
 * server-global, so a neighbour that resets it between this call and the turn
 * that needs it leaves the test driving a runtime it did not choose — and the
 * way that shows up is a turn that finishes instantly, which reads as "the flip
 * did nothing" rather than "the scenario was not installed".
 *
 * @param request - The test's API context.
 * @param name - The scenario to install.
 */
async function useScenario(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post('/api/test/scenario', { data: { name } });
  if (!res.ok()) throw new Error(`Could not set the scenario to ${name}: ${await res.text()}`);
  const { scenario } = (await res.json()) as { scenario?: string };
  if (scenario !== name) {
    throw new Error(
      `Asked for the '${name}' scenario and the server acknowledged '${scenario}'. ` +
        `The scenario store is server-global — something else on this leg is writing it.`
    );
  }
}

/**
 * Turn the flip on or off.
 *
 * Read live per turn, so this binds the very next message rather than the next
 * server start — the same contract `rooms.collectDebounceMs` keeps, and the same
 * `PATCH /api/config` route Settings writes.
 *
 * @param request - The test's API context.
 * @param on - Whether a turn's own words stop being the room's message.
 */
async function setToolOnlyReplies(request: APIRequestContext, on: boolean): Promise<void> {
  const res = await request.patch('/api/config', { data: { rooms: { toolOnlyReplies: on } } });
  if (!res.ok()) throw new Error(`Could not set rooms.toolOnlyReplies: ${await res.text()}`);
}

/**
 * Post into a room AS AN AGENT, through the real `post_to_room` capability.
 *
 * **A fabricated token would not fail — it would DEGRADE**, which is the trap
 * `POST /api/test/agent-token` exists to close: a made-up `X-DorkOS-Agent`
 * header falls through to the install owner, and the post lands under the
 * PERSON's author id. A test that faked one would pass while proving the
 * opposite of its name.
 *
 * @param request - The test's API context.
 * @param opts.roomId - The room to post into.
 * @param opts.agentPath - The posting agent's registered directory.
 * @param opts.text - What to say.
 */
async function postAsAgent(
  request: APIRequestContext,
  opts: { roomId: string; agentPath: string; text: string }
): Promise<void> {
  const minted = await request.post('/api/test/agent-token', {
    data: { agentPath: opts.agentPath },
  });
  if (!minted.ok()) throw new Error(`Could not mint an agent token: ${await minted.text()}`);
  const { token } = (await minted.json()) as { token: string };
  const posted = await request.post('/api/capabilities/rooms.post/invoke', {
    headers: { 'X-DorkOS-Agent': token },
    data: { roomId: opts.roomId, text: opts.text },
  });
  if (!posted.ok()) throw new Error(`The agent could not post: ${await posted.text()}`);
}

/**
 * End every held turn, so a test never leaves one ticking after its assertions.
 *
 * @param request - The test's API context.
 */
async function finishTurns(request: APIRequestContext): Promise<void> {
  await request.post('/api/test/finish-turn');
}

/**
 * The author id of a room's one agent seat, with that seat set to answer.
 *
 * @param roomsApi - The seeding fixture, which owns the membership write.
 * @param room - The room whose roster to read.
 * @param name - The agent's display name.
 * @param mode - The response mode to seat it on.
 */
async function seatThatAnswers(
  roomsApi: { setResponseMode: (r: string, a: string, m: string) => Promise<void> },
  room: SeededRoom,
  name: string,
  mode: string
): Promise<string> {
  const seat = room.members.find((member) => member.author.displayName === name);
  if (!seat) {
    throw new Error(
      `${name} is not on ${room.id}'s roster: ` +
        room.members.map((m) => `${m.author.kind}:${m.author.displayName}`).join(', ')
    );
  }
  await roomsApi.setResponseMode(room.id, seat.author.id, mode);
  return seat.author.id;
}

/**
 * Open one room by id and wait until it is really on screen.
 *
 * The barrier is the MASTHEAD, not the feed: `room-timeline` is mounted only
 * once something has been said, and every room here is seeded empty.
 *
 * @param page - The test's page.
 * @param basePage - The shell page object, for app readiness.
 * @param roomsPage - The rooms page object, for the masthead.
 * @param roomId - The room to open.
 */
async function openRoom(
  page: Page,
  basePage: { waitForAppReady: () => Promise<void> },
  roomsPage: { roomHeader: Locator },
  roomId: string
): Promise<void> {
  await page.goto(`/channels?id=${roomId}`);
  await basePage.waitForAppReady();
  await expect(roomsPage.roomHeader).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
}

/**
 * Wait until the bar says this room is busy — the turn has really started.
 *
 * Not `toBeVisible()` on the Stop button: the working chip is mounted at all
 * times and merely faded while idle, and Playwright counts an `opacity: 0`
 * element with a box as visible. `data-idle` is the state itself.
 *
 * @param page - The page under test.
 */
async function expectRoomBusy(page: Page): Promise<void> {
  await expect(page.getByTestId('room-run-state')).toHaveAttribute('data-idle', 'false', {
    timeout: SERVER_ROUND_TRIP_MS,
  });
}

/**
 * Wait until the bar says nothing is running here.
 *
 * @param page - The page under test.
 */
async function expectRoomIdle(page: Page): Promise<void> {
  await expect(page.getByTestId('room-run-state')).toHaveAttribute('data-idle', 'true', {
    timeout: SERVER_ROUND_TRIP_MS,
  });
}

/**
 * Serial, and for the reason `room-autonomy.spec.ts` is: every test here writes
 * two pieces of server-global state — the flip, and the scenario the runtime
 * answers with. Run in parallel they overwrite each other, and the way that
 * shows up is not a race that sometimes fails but a result that looks like a
 * product bug (a turn whose text posted anyway, or one that finished instantly).
 *
 * The timeout is the file's because each test holds a turn open across a real
 * page load, which the suite's 30s default cannot fail informatively inside of.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('An agent decides for itself whether to speak', () => {
  test.beforeEach(async ({ request }) => {
    await requireTestModeLeg(request);
    await setToolOnlyReplies(request, true);
  });

  test.afterEach(async ({ request }) => {
    await finishTurns(request);
    await setToolOnlyReplies(request, TOOL_ONLY_DEFAULT);
    await useScenario(request, 'simple-text').catch(() => {});
  });

  test('a tool-only reply lands once, and its own narration never reaches the room', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    await useScenario(request, NARRATING);
    const tag = roomsApi.runId;
    const name = `Speaker${tag}`;
    const agent = await roomsApi.registerAgent(name, '🗣️', '#7c3aed');
    const room = await roomsApi.createChannel(`tool-only-${tag}`, `Tool only ${tag}`, [agent]);
    const seat = await seatThatAnswers(roomsApi, room, name, 'always');

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsApi.postEntries(room.id, [`is the build green ${tag}?`]);
    // The turn is held open, so this is MID-turn — exactly where an injected
    // `dorkos` server would make the call. Waiting for the room to report itself
    // busy is what makes that a fact rather than a hope: a post that raced ahead
    // of the claim would carry no turn and exercise none of the marks.
    await expectRoomBusy(page);
    await postAsAgent(request, {
      roomId: room.id,
      agentPath: agent.projectPath,
      text: `yes, green as of just now ${tag}`,
    });
    await finishTurns(request);

    const settled = await roomsApi.waitForEntry(
      room.id,
      (entry) => entry.authorId === seat,
      `a tool post from ${name}`
    );

    const replies = settled.filter((entry) => entry.authorId === seat);
    expect(
      replies.map((entry) => entry.body.text),
      'the turn produced more than one entry'
    ).toHaveLength(1);
    expect(replies[0]!.body.text).toContain(`green as of just now ${tag}`);
    // The one assertion a count cannot make: the narration is absent from EVERY
    // entry, not merely from the one that happened to be checked.
    for (const entry of settled) expect(entry.body.text).not.toContain(NARRATION);

    // And a person sees it as an answer to the question, which is what
    // `postFromTool` filling `answersEntryId` from the live claim buys — before
    // DOR-1613 a tool post carried no pointer at all.
    await expect(page.getByTestId('room-timeline')).toContainText(`green as of just now ${tag}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expectRoomIdle(page);
  });

  test('a person asked and got nothing, so the room says one line about it', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    await useScenario(request, QUIET);
    const tag = roomsApi.runId;
    const name = `Decliner${tag}`;
    const agent = await roomsApi.registerAgent(name, '🤐', '#0891b2');
    // **A DIRECT MESSAGE, and the choice is load-bearing twice over.** The
    // notice is owed only to somebody who ASKED, and in a DM every message a
    // person sends is addressed to whoever is on the other side — no `@` needed,
    // which is what `directlyAsked` reads. That also makes this the shape §2.6's
    // reversal created: before DOR-1613 an agent could not decline in a DM at
    // all, because its text posted whatever it thought.
    const room = await roomsApi.createDirectMessage(`Declined ${tag}`, [agent]);
    const seat = await seatThatAnswers(roomsApi, room, name, 'always');

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsApi.postEntries(room.id, [`is the build green ${tag}?`]);
    await expectRoomBusy(page);
    await finishTurns(request);

    const settled = await roomsApi.waitForEntry(
      room.id,
      (entry) => entry.kind === 'notice' && entry.body.notice === 'agent_declined',
      'the room saying the agent read it and did not reply'
    );

    const declines = settled.filter((entry) => entry.body.notice === 'agent_declined');
    expect(declines, 'the room wrote more than one line about one silence').toHaveLength(1);
    expect(declines[0]!.body.subjectAuthorId).toBe(seat);
    // The agent itself said nothing — the line is the ROOM's voice, not its.
    expect(
      settled.filter((entry) => entry.authorId === seat && entry.kind === 'post')
    ).toHaveLength(0);

    await expect(page.getByTestId('room-timeline')).toContainText('did not reply', {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expectRoomIdle(page);
  });

  test('nobody asked, so a quiet turn leaves the room unchanged and the pill clears', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    // The NARRATING scenario, deliberately: a turn that produces no text at all
    // would post nothing whether the flip were on or off, so the assertion
    // below would hold against a path that never changed. This turn writes a
    // sentence back to its own session, and what is being proved is that the
    // sentence stays there.
    await useScenario(request, NARRATING);
    const tag = roomsApi.runId;
    const name = `Listener${tag}`;
    const agent = await roomsApi.registerAgent(name, '👂', '#16a34a');
    const room = await roomsApi.createChannel(`ambient-${tag}`, `Ambient ${tag}`, [agent]);
    const seat = await seatThatAnswers(roomsApi, room, name, 'always');

    await openRoom(page, basePage, roomsPage, room.id);
    // No mention: the agent runs a turn because its seat is `always`, which is
    // the ambient case etiquette E7 says must stay free.
    await roomsApi.postEntries(room.id, [`the deploy finished ${tag}`]);
    await expectRoomBusy(page);
    await finishTurns(request);

    // **The indicator clearing is the settle**, and it is the assertion too. An
    // absence cannot be waited for, so what is waited for is the thing that
    // happens instead: the room going idle, which the release publishes AFTER
    // any durable write it was going to make.
    await expectRoomIdle(page);

    const entries = await roomsApi.listEntries(room.id);
    expect(
      entries.filter((entry) => entry.authorId === seat),
      'a turn nobody asked for left something behind'
    ).toHaveLength(0);
    expect(
      entries.filter((entry) => entry.kind === 'notice'),
      'the room apologised for a silence nobody asked about'
    ).toHaveLength(0);
    for (const entry of entries) expect(entry.body.text).not.toContain(NARRATION);
  });
});
