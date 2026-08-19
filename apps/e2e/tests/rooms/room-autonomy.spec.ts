import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS, type SeededRoom } from '../../fixtures/rooms-api';

/**
 * What a room does when several people talk at once, and how it is stopped
 * (room-participation spec §10.4, RP8 — capabilities A-03 and A-16).
 *
 * Four mechanics, all of them about an agent TAKING A TURN, which is why this
 * file is the only rooms spec that lets one:
 *
 * 1. a burst gathers into ONE answer, and the answer is to the newest message;
 * 2. a message sent while the agent is working is answered, not refused;
 * 3. a message for an agent busy in ANOTHER room waits, says so, and is
 *    answered here when that turn ends;
 * 4. the Stop button in the masthead stops everything and says so ONCE;
 * 5. a message whose text is "stop" is a message, not a control.
 *
 * All of them are pinned below the browser already — `room-collect.test.ts` and
 * `room-stopped-turns.test.ts` between them cover thirty-odd cases with a
 * scripted runner. What only a browser can add is that the mechanics are wired
 * to something a person can see and press: the masthead really draws a Stop
 * while agents work, pressing it really reaches the room, and the room really
 * says one sentence about it.
 *
 * ## Why the TEST-MODE leg, and why that is a safety property
 *
 * The same argument `home-surface/team-room.spec.ts` makes. Every test here
 * un-silences an agent — which the `roomsApi` fixture otherwise guarantees never
 * happens — and on the cockpit leg that means a real Claude Code turn against
 * whatever `claude` sign-in the machine has, billed, four times over. There is
 * no key to withhold that prevents it. The test-mode leg registers a
 * `claude-code`-typed `TestModeRuntime` alias (`DORKOS_TEST_RUNTIME_CLAUDE_ALIAS`),
 * so the same seat answers for free and deterministically.
 *
 * {@link requireTestModeLeg} makes that a check rather than a hope: it is the
 * first thing every test does, and it fails naming the cause rather than
 * spending money.
 *
 * ## The collect window is SEEDED, not waited out
 *
 * `rooms.collectDebounceMs` ships at 500ms, which is a sensible product default
 * and far too tight to aim at: three posts have to land inside one window, and
 * on a machine already several worktrees deep in agents 500ms is not a number a
 * test can rely on. So this file writes the window it needs through
 * `PATCH /api/config` — the same route Settings writes, read live per burst
 * (`room-collect.ts`, "the live `rooms.collect*` ceilings, read per burst so a
 * change takes effect"), so no restart is involved and the value is in force for
 * the very next message.
 *
 * Restoring it to {@link COLLECT_WINDOW_DEFAULT_MS} rather than to whatever was
 * there is exact, not approximate: this leg's `DORK_HOME` is deleted before
 * every boot (`playwright.config.ts`), so it starts on the schema default and
 * nothing but this file ever moves it.
 *
 * ## What this file borrows from the whole test-mode leg
 *
 * The scenario store is server-global — `POST /api/test/scenario` sets a default
 * for everybody and `POST /api/test/reset` puts it back for everybody. Two of
 * the tests below need a turn that is still running when they do something to
 * it, which is what `long-turn` is for, and it is the same borrowing
 * `streams/session-queue.spec.ts` already does. Under CI that is exact, because
 * CI runs `workers: 1` and nothing else is running. Locally, a parallel run can
 * collide; the mitigations are that each test restores `simple-text` in a
 * `finally`, and that the file never leaves a 180-second generator behind.
 *
 * ## What a browser CANNOT see here, said out loud
 *
 * - **`arrivedDuringPrevTurn`** — the mark that tells the agent a message
 *   arrived while it was working — is model-facing only. It rides the turn's
 *   `additionalContext` and is rendered into the agent's room-context block; it
 *   is in no entry, on no wire the cockpit reads, and in no DOM node. So test 2
 *   asserts the BEHAVIOUR (the message is answered rather than refused), and the
 *   mark itself stays pinned where it is visible, in `room-collect.test.ts`.
 * - **A halt killing the runtime.** `TestModeRuntime.interruptQuery` answers
 *   `false` — there is no process to signal — so what test 3 proves is the
 *   room's half: the claims drop, the indicator goes, and one notice is written.
 *   That is deliberately the stubborn-runtime path, and the right half to prove
 *   in a browser; the interrupt itself is pinned in `room-stopped-turns.test.ts`.
 */

/**
 * The collect window this file runs with.
 *
 * Six times the shipped default, chosen so that three sequential API posts —
 * tens of milliseconds on an idle machine, and a great deal more on a busy one —
 * cannot straddle it. It is not a delay anything waits out: the only test that
 * pays it twice is the burst, and 3s twice is the price of the claim.
 */
const COLLECT_WINDOW_MS = 3_000;

/** What `rooms.collectDebounceMs` ships as, and what this file puts back. */
const COLLECT_WINDOW_DEFAULT_MS = 500;

/**
 * Put the runtime back to a known state, and refuse to run anywhere but the
 * test-mode leg.
 *
 * **The reset is not tidiness — one flag makes this file order-dependent
 * without it.** `POST /api/test/finish-turn` is deliberately STICKY: from the
 * moment it is raised, every `long-turn` finishes at its first heartbeat, which
 * is what a test watching something drain actually wants. The cost is that the
 * next test to need a turn that STAYS running silently gets one that does not —
 * and the way that shows up is `room-header-halt` never rendering, which reads
 * as "the Stop button is broken" rather than "there was nothing to stop". That
 * cost a debugging cycle here.
 *
 * `reset` clears the flag and puts the default scenario back, so each test below
 * starts from the same place whatever its neighbours did. It is the same global
 * operation `chat-mock.spec.ts` runs before every one of its tests.
 *
 * And it doubles as the leg check: `/api/test/*` is mounted only under
 * `DORKOS_TEST_RUNTIME` (`app.ts`), so a 404 means this spec is pointed at the
 * cockpit leg — where the agents it is about to un-silence would answer with a
 * real model on the machine's own sign-in.
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
 * **The read-back is the guard, not politeness.** The scenario store is
 * server-global, so a neighbour that resets it between this call and the turn
 * that needs it leaves the test driving a runtime it did not choose — and the
 * two ways that shows up both read as product bugs: an instant turn means
 * `room-header-halt` never renders ("the Stop button is broken"), and an
 * unexpected `long-turn` means a reply says `Working on it` instead of echoing
 * ("the room answered the wrong message"). Both happened here before this file
 * was made serial. Serial fixes it TODAY; this is what will name the cause if
 * anyone ever runs these with more than one worker.
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
 * Set how long a room gathers messages before answering.
 *
 * @param request - The test's API context.
 * @param ms - The window, in milliseconds.
 */
async function setCollectWindow(request: APIRequestContext, ms: number): Promise<void> {
  // A partial patch: `applyConfigPatch` deep-merges, so naming one field leaves
  // `rooms.collectMaxEntries` and everything else under `rooms` alone.
  const res = await request.patch('/api/config', { data: { rooms: { collectDebounceMs: ms } } });
  if (!res.ok()) throw new Error(`Could not set the collect window: ${await res.text()}`);
}

/**
 * The author id of a room's one agent seat, with that seat set to answer.
 *
 * `always` rather than `engaged`: these tests post plain messages that address
 * nobody, and an engaged seat is one that answers when it is spoken to. Nothing
 * here is about addressing — the mechanics under test are about how many turns
 * a burst becomes, not about who it was for.
 *
 * @param roomsApi - The seeding fixture, which owns the membership write.
 * @param room - The room whose roster to read.
 * @param name - The agent's display name.
 */
async function seatThatAnswers(
  roomsApi: { setResponseMode: (r: string, a: string, m: string) => Promise<void> },
  room: SeededRoom,
  name: string
): Promise<string> {
  const seat = room.members.find((member) => member.author.displayName === name);
  if (!seat) {
    throw new Error(
      `${name} is not on ${room.id}'s roster: ` +
        room.members.map((m) => `${m.author.kind}:${m.author.displayName}`).join(', ')
    );
  }
  await roomsApi.setResponseMode(room.id, seat.author.id, 'always');
  return seat.author.id;
}

/**
 * Open one room by id and wait until it is really on screen.
 *
 * The barrier is the MASTHEAD, not the feed. `room-timeline` is mounted only
 * once something has been said in the room (the same fact
 * `home-surface/team-room.spec.ts` names), and every room here is seeded empty
 * and posted into afterwards — so waiting on the feed waits for a thing that is
 * correctly absent, and all four tests failed that way before this existed.
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
 * Serial, and it has to be.
 *
 * `fullyParallel` schedules individual TESTS onto concurrent workers, not just
 * files — and every test here writes two pieces of server-global state: the
 * collect window, and the scenario the runtime answers with. Run in parallel
 * they overwrite each other, and the way that shows up is not a race that
 * sometimes fails: the "stop" test read back `Working on it` because a
 * neighbour had installed `long-turn` underneath it, and the halt test never saw
 * a Stop because a neighbour had put `simple-text` back. Both look like product
 * bugs and neither is one.
 *
 * The timeout is the file's because two of these wait out a collect window and
 * a real turn apiece, which the suite's 30s default cannot fail informatively
 * inside of.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('A room gathers what is said at once @smoke', () => {
  test.beforeEach(async ({ request }) => {
    await requireTestModeLeg(request);
    await setCollectWindow(request, COLLECT_WINDOW_MS);
  });

  test.afterEach(async ({ request }) => {
    await setCollectWindow(request, COLLECT_WINDOW_DEFAULT_MS);
    await useScenario(request, 'simple-text').catch(() => {});
  });

  test('three quick messages become ONE answer, and it answers the newest', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const tag = roomsApi.runId;
    const name = `Collector${tag}`;
    const agent = await roomsApi.registerAgent(name, '🧺', '#7c3aed');
    const room = await roomsApi.createChannel(`burst-${tag}`, `Burst ${tag}`, [agent]);
    const seat = await seatThatAnswers(roomsApi, room, name);

    await openRoom(page, basePage, roomsPage, room.id);

    // Three, inside one window. `postEntries` sends them one at a time and only
    // then waits for them to be stored, so the sending is as fast as three
    // round trips and nothing here waits between them.
    await roomsApi.postEntries(room.id, [`one ${tag}`, `two ${tag}`, `three ${tag}`]);

    await roomsApi.waitForEntry(
      room.id,
      (entry) => entry.authorId === seat,
      `an answer from ${name}`
    );

    // **A second message, sent after the window shut, is the settle.** Counting
    // replies straight after the first one arrives would be asking "have the
    // other two turns not happened YET" — a question a sleep answers badly. A
    // message that gets its own answer proves the room has moved on past the
    // burst, so the count below is read after everything the burst could
    // possibly produce has had its turn.
    await roomsApi.postEntries(room.id, [`four ${tag}`]);
    const settled = await roomsApi.waitForEntry(
      room.id,
      (entry) => entry.authorId === seat && entry.body.text.includes(`four ${tag}`),
      `a separate answer to "four ${tag}"`
    );

    const replies = settled.filter((entry) => entry.authorId === seat);
    expect(
      replies.map((entry) => entry.body.text),
      'the burst produced more than one turn'
    ).toHaveLength(2);

    // **Which message it answered**, not merely how many answers there were.
    // The turn's prompt is the newest entry of the window verbatim
    // (`room-trigger.ts`, `prompt: entry.body.text`) and the test-mode default
    // scenario echoes what it was asked, so the reply's own words say which of
    // the three the agent was put in front of. The other two are not lost —
    // they ride the ambient context block, which is not something a room shows.
    expect(replies[0]!.body.text).toContain(`three ${tag}`);
    expect(replies[0]!.body.text).not.toContain(`one ${tag}`);

    // One budget charge, one claim, one cursor — and one line in the room. What
    // the reader sees is the whole point of collecting.
    await expect(page.getByTestId('room-timeline')).toContainText(`three ${tag}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });

  test('a message sent while the agent is working is answered, not turned away', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    const tag = roomsApi.runId;
    const name = `Steerer${tag}`;
    const agent = await roomsApi.registerAgent(name, '🧭', '#0ea5e9');
    const room = await roomsApi.createChannel(`steer-${tag}`, `Steer ${tag}`, [agent]);
    const seat = await seatThatAnswers(roomsApi, room, name);

    await openRoom(page, basePage, roomsPage, room.id);

    // A turn that is still running when the second message lands. Without it
    // there is no mid-turn to arrive during: every built-in scenario finishes
    // inside a frame, and the test would be racing a turn it cannot see.
    await useScenario(request, 'long-turn');
    try {
      await roomsApi.postEntries(room.id, [`first ${tag}`]);

      // The masthead's Stop is the honest barrier: it renders only while this
      // room's working count is above zero, so it appearing IS the turn having
      // started. Waiting on it rather than on a stopwatch is what makes the
      // next line reliably mid-turn.
      await expect(page.getByTestId('room-header-halt')).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });

      await roomsApi.postEntries(room.id, [`second ${tag}`]);
      // Let the first turn end. The held message runs off the CLAIM's release,
      // which is the one place every terminal passes through, so this is the
      // whole mechanism firing.
      await request.post('/api/test/finish-turn');

      // **Counted, not matched — TWO answers for two messages.** The message
      // that arrived mid-turn was picked up, not dropped behind the agent's
      // cursor to wait for some unrelated message to come along.
      //
      // A `long-turn` answer says "Working on it." whichever message it is for
      // — it echoes nothing — so there is no text to recognise the second reply
      // by, and the predicate that tried was satisfied by the FIRST one and duly
      // reported a working feature as broken. What the claim is about is a
      // number, so the wait is on the number.
      await expect
        .poll(
          async () =>
            (await roomsApi.listEntries(room.id)).filter((entry) => entry.authorId === seat).length,
          {
            timeout: SERVER_ROUND_TRIP_MS,
            message: 'the message that arrived mid-turn never got an answer',
          }
        )
        .toBeGreaterThanOrEqual(2);
      const settled = await roomsApi.listEntries(room.id);
      const answers = settled.filter((entry) => entry.authorId === seat);

      // **Then the count, read off the settled room rather than off the poll.**
      // A poll that insisted on exactly 2 would keep waiting through a THIRD
      // answer and then report "never got an answer", which is the opposite of
      // what went wrong: two messages that produced three turns is a
      // double-trigger, not a dropped message. The poll waits for the answer;
      // this says how many there were.
      expect(
        answers.map((entry) => entry.body.text),
        'two messages did not produce exactly two answers'
      ).toHaveLength(2);

      // And no refusal. `working-here` is gone from `BusyContext` (RP8), so the
      // room has nothing to say about a message it is about to answer — a
      // "didn't pick this up" line here would be the room lying.
      expect(
        settled.filter((entry) => entry.body.notice !== undefined).map((e) => e.body.notice),
        'the room refused a message it went on to answer'
      ).toHaveLength(0);
    } finally {
      // Sticky, and that is what is wanted: from here on every `long-turn`
      // finishes at once, so nothing this file started can outlive it.
      await request.post('/api/test/finish-turn').catch(() => {});
      await useScenario(request, 'simple-text').catch(() => {});
    }
  });

  test('a message for an agent busy in ANOTHER room waits, and is never turned away', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    // The bug this shipped for. One agent is one working directory, so it can
    // only run one turn at a time — and a message that arrived for it while it
    // was busy in a different room used to be dropped with a line asking the
    // person to send it again. Now it waits, the room says so while it is still
    // true, and the answer lands here.
    //
    // What only a browser can add: the LINE. The ordering across three rooms and
    // the promote path are pinned in units, because both need a deterministic
    // clock and a third room.
    const tag = roomsApi.runId;
    const name = `Waiter${tag}`;
    const agent = await roomsApi.registerAgent(name, '⏳', '#f59e0b');
    const busy = await roomsApi.createChannel(`busy-${tag}`, `Busy ${tag}`, [agent]);
    const asking = await roomsApi.createChannel(`asking-${tag}`, `Asking ${tag}`, [agent]);
    await seatThatAnswers(roomsApi, busy, name);
    const seat = await seatThatAnswers(roomsApi, asking, name);

    await useScenario(request, 'long-turn');
    try {
      // The agent takes a turn in the OTHER room and stays in it.
      await openRoom(page, basePage, roomsPage, busy.id);
      await roomsApi.postEntries(busy.id, [`over here ${tag}`]);
      await expect(page.getByTestId('room-header-halt')).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // Now ask it something in a room it is not working in.
      await openRoom(page, basePage, roomsPage, asking.id);
      await roomsApi.postEntries(asking.id, [`and over here ${tag}`]);

      // **The line, in this room's own voice, naming the conversation in the way
      // — and the NAME is the assertion.** The wire carries a room id and
      // nothing else; the client resolves it against the rooms this reader can
      // already see, and falls back to "another conversation" when it cannot.
      // Matching the shared prefix would pass on the fallback too, so the one
      // thing only a browser can prove — that the per-reader resolution works —
      // would go unchecked.
      const waitingLine = page.getByTestId('room-held');
      await expect(waitingLine).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(waitingLine).toHaveText(
        `${name} will pick this up when it finishes in #busy-${tag}`
      );

      // And nothing durable. This is the whole regression: the room used to put
      // a line here asking the person to send the message again.
      expect(
        (await roomsApi.listEntries(asking.id))
          .filter((entry) => entry.body.notice !== undefined)
          .map((entry) => entry.body.notice),
        'the room wrote a notice about a message it was going to answer'
      ).toHaveLength(0);

      // The id of the message that waited, so the answer can be checked against
      // THIS question rather than against "some reply".
      const askedId = (await roomsApi.listEntries(asking.id)).find(
        (entry) => entry.body.text === `and over here ${tag}`
      )!.id;

      // The blocking turn ends, and the waiting message becomes a turn HERE.
      await request.post('/api/test/finish-turn');
      await expect
        .poll(
          async () =>
            (await roomsApi.listEntries(asking.id)).filter((entry) => entry.authorId === seat)
              .length,
          {
            timeout: SERVER_ROUND_TRIP_MS,
            message: 'the message that waited on a busy agent never got an answer',
          }
        )
        .toBe(1);

      // **One answer, and it says which message it answers.** A count alone is
      // satisfied by any reply at all; the pointer is what says the room
      // answered the question that waited rather than something else it happened
      // to pick up.
      const answers = (await roomsApi.listEntries(asking.id)).filter(
        (entry) => entry.authorId === seat
      );
      expect(answers, 'one waiting message did not produce exactly one answer').toHaveLength(1);
      expect(
        answers[0].body.answersEntryId,
        'the answer does not point at the message that waited'
      ).toBe(askedId);

      // The line resolves rather than sitting beside the answer.
      await expect(waitingLine).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
      expect(
        (await roomsApi.listEntries(asking.id))
          .filter((entry) => entry.body.notice !== undefined)
          .map((entry) => entry.body.notice),
        'the room refused a message it went on to answer'
      ).toHaveLength(0);
    } finally {
      await request.post('/api/test/finish-turn').catch(() => {});
      await useScenario(request, 'simple-text').catch(() => {});
    }
  });
});

test.describe('Stopping a room @smoke', () => {
  test.beforeEach(async ({ request }) => {
    await requireTestModeLeg(request);
    await setCollectWindow(request, COLLECT_WINDOW_MS);
  });

  test.afterEach(async ({ request }) => {
    await setCollectWindow(request, COLLECT_WINDOW_DEFAULT_MS);
    await useScenario(request, 'simple-text').catch(() => {});
  });

  test('the Stop button stops every agent working here, and the room says so once', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    const tag = roomsApi.runId;
    const first = `Halta${tag}`;
    const second = `Haltb${tag}`;
    const agents = [
      await roomsApi.registerAgent(first, '🛑', '#ef4444'),
      await roomsApi.registerAgent(second, '🚦', '#f59e0b'),
    ];
    const room = await roomsApi.createChannel(`halt-${tag}`, `Halt ${tag}`, agents);
    await seatThatAnswers(roomsApi, room, first);
    await seatThatAnswers(roomsApi, room, second);

    await openRoom(page, basePage, roomsPage, room.id);

    await useScenario(request, 'long-turn');
    try {
      // One message, two seats that answer everything: two turns, which is what
      // makes "every in-flight turn" a claim with a number in it.
      await roomsApi.postEntries(room.id, [`everyone look at this ${tag}`]);

      const stop = page.getByTestId('room-header-halt');
      await expect(stop).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      // Both of them, before the press. A Stop pressed while only one had
      // started would prove nothing about "every".
      await expect(page.getByTestId('room-header-working')).toHaveText(/2 agents working/, {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      await stop.click();

      // ONE line, and its words carry the count — which is how a browser can
      // tell "stopped everything" from "stopped one of them". The copy is the
      // server's (`buildHaltedNotice`), so this is reading back what the halt
      // actually did rather than what the button hoped.
      const halted = page.locator('[data-testid="room-notice"][data-notice="halted"]');
      await expect(halted).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
      await expect(halted).toContainText('2 agents were working');

      // The indicator goes with it — the button is drawn only while something is
      // working, so its absence is the working count reaching zero.
      await expect(stop).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });

      // In the room, not just on the screen: exactly one halted row was stored.
      const stored = await roomsApi.listEntries(room.id);
      expect(
        stored.filter((entry) => entry.body.notice === 'halted'),
        'a halt wrote more than one notice'
      ).toHaveLength(1);
    } finally {
      // Through the API rather than the button: if the assertions above failed,
      // the button may be exactly what is missing, and a 180-second generator
      // must not be left holding a claim either way.
      await request.post(`/api/rooms/${room.id}/halt`).catch(() => {});
      await request.post('/api/test/finish-turn').catch(() => {});
      await useScenario(request, 'simple-text').catch(() => {});
    }
  });

  test('a message whose text is "stop" is answered like any other message', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const tag = roomsApi.runId;
    const name = `Wordy${tag}`;
    const agent = await roomsApi.registerAgent(name, '💬', '#22c55e');
    const room = await roomsApi.createChannel(`word-${tag}`, `Word ${tag}`, [agent]);
    const seat = await seatThatAnswers(roomsApi, room, name);

    await openRoom(page, basePage, roomsPage, room.id);

    // The word itself, with nothing around it — the exact shape the Hermes loop
    // incident produced, and the one a product that inferred stopping from text
    // would act on. Untagged on purpose: a tag would make it a different string
    // from the one that matters, and this room is this test's own, so nothing
    // else can be posting into it.
    await roomsApi.postEntries(room.id, ['stop']);

    const settled = await roomsApi.waitForEntry(
      room.id,
      (entry) => entry.authorId === seat,
      `an ordinary answer to "stop"`
    );

    // Answered, and answered to the word: a turn really ran on it.
    expect(settled.filter((entry) => entry.authorId === seat)).toHaveLength(1);
    expect(settled.find((entry) => entry.authorId === seat)!.body.text).toContain('stop');

    // And nothing was stopped. Stopping is something you press
    // (`use-halt-room.ts`), so the room has no halted line to show for a
    // sentence somebody typed.
    expect(
      settled.filter((entry) => entry.body.notice === 'halted'),
      'the room treated a typed word as the Stop button'
    ).toHaveLength(0);
    await expect(page.locator('[data-testid="room-notice"][data-notice="halted"]')).toHaveCount(0);
  });
});
