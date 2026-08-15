/**
 * The `rooms` suite — what a channel DOES about a message, and what it costs.
 *
 * Two tiers, doing two different jobs (`specs/engaged-response-gate/01-ideation.md`
 * §13.2 and `meta/chat-capabilities.md` §7):
 *
 * - **This file is the STRUCTURAL tier**: four mechanism cases on `test-mode`.
 *   No model, no spend, seconds, and they GATE — they are the only cases in the
 *   suite that do. Run them with
 *   `pnpm evals -- --suite rooms --tier test-mode`.
 * - `rooms-recall.ts` is the CREDENTIALED tier: the context-recall probes,
 *   restraint, and the adversarial-injection case, all quarantined.
 *
 * ## What "a turn ran" means here, and why it is not "the agent replied"
 *
 * Every oracle in this file reads the room's own durable stream
 * (`GET /api/rooms/:id/events`) or the `room_turn_spend` rows in the sandbox
 * database. A triggered turn is a WORKING INDICATOR naming the agent, which is
 * what makes a turn that ends with nothing to say distinguishable from a turn
 * that never started — the exact distinction the engaged-response-gate work has
 * to be able to measure. See `oracles/rooms.ts`.
 *
 * ## The one thing these cases deliberately do NOT assert
 *
 * That an ENGAGED agent's quiet turn is free. It is not: `tryReserve` is charged
 * once per target with no discrimination by trigger reason
 * (`turn-budget.ts`), so today an ambient message an agent has nothing to say
 * about still spends a turn out of the room's hourly ceiling. That is the cost
 * DOR-1203's response gate exists to remove, and writing an eval that asserts
 * the post-gate behaviour today would ship a red that means nothing.
 * {@link roomsUnaddressedIsFreeCase} asserts the half that IS true now — a
 * message that addresses nobody costs nothing — and it is the case the gate work
 * will extend rather than replace.
 *
 * ## Skipped on purpose
 *
 * `meta/chat-capabilities.md` §7 lists eight context probes. **X-07 (the same
 * probes in a bridged room) and X-08 (a probe after the bound session compacted)
 * are not implemented, in either tier**, and are not faked:
 *
 * - **X-07** needs a bridged room, and the only way to mint one is
 *   `POST /api/test/seed-bridge`, which exists solely under
 *   `DORKOS_TEST_RUNTIME`. So it is reachable exactly where there is no model to
 *   answer a recall probe, and unreachable on the tier that has one. A bridged
 *   recall probe needs a credentialed server that can mint a bridge, which is
 *   product work (or harness work on the child-process boot), not a case.
 * - **X-08** needs a compaction to have HAPPENED inside the room's bound
 *   session. Compaction is a session-level command intent, the room binds its
 *   session internally, and nothing exposes "compact the session this room bound
 *   for that agent". Driving `/compact` would need the session id, which is only
 *   knowable after a turn, and a second surface to send it on.
 *
 * Both stay listed as gaps in `meta/chat-capabilities.md` §9 rather than
 * appearing here as green cases that assert nothing.
 *
 * ## The drill (run it after changing any oracle here)
 *
 * Every oracle owes a recipe that makes it red (README, "a new oracle ships with
 * a drill"). The per-oracle ones are executable — `oracles/__tests__/rooms.test.ts`
 * shows each oracle green on the frames that should pass it and red on the ones
 * that should not, because a room oracle reads frames and a frame set is a seed
 * you can write down. This is the END-TO-END one, and it costs nothing:
 *
 * 1. **the seed**: in `apps/server/src/services/rooms/addressing.ts`, change
 *    `case 'mention-only': return opts.mentioned;` to `return false;` — an agent
 *    that can be named and never answers;
 * 2. **the command**, in full (no isolation flag: this tier is in-process, and
 *    there is no model to authenticate):
 *
 *    ```bash
 *    pnpm --filter @dorkos/evals run evals -- --suite rooms --tier test-mode
 *    ```
 *
 * 3. **what to expect.** `rooms-addressed-runs-a-turn` fails with ALL THREE of
 *    its oracles red — no indicator, nothing posted, nothing charged — and the
 *    burst and halt cases fail too, since both address the agent to get a turn at
 *    all. `rooms-unaddressed-is-free` stays GREEN, which is the half of the
 *    result that says the oracles discriminate rather than failing together. The
 *    suite's eight credentialed cases take no part in the drill: a `test-mode`
 *    run does not start them (`skipped-wrong-tier`). Measured on 2026-08-15, not
 *    predicted;
 * 4. **reproduction versus noise**: a real drill red names the agent's author id
 *    in oracle 1's detail (`no working indicator named ada (01M…)`). A run where
 *    the case ERRORS instead — a stream that never settled, a boot fault — proves
 *    nothing about the oracles and should be repeated;
 * 5. **where to read the answer**: the table this run prints is enough here,
 *    because these cases gate; per-oracle details are in
 *    `.evals-runs/<run id>/results.json`.
 *
 * Then remove the seed and confirm all four go green again.
 *
 * @module evals/suite/rooms
 */
import type { EvalCase, RoomScriptResult } from '../types.js';
import {
  finishTestTurns,
  haltRoom,
  postToRoom,
  resetTestMode,
  selectTestScenario,
} from '../runner/room-drive.js';
import { waitForRoomFrames } from '../runner/room-drive.js';
import {
  agentPostedInRoom,
  agentStayedQuietInRoom,
  noRoomTurnFor,
  observedTurns,
  roomNoticeCount,
  roomScriptNote,
  roomSpentNoTurnBudget,
  roomTurnBudgetSpent,
  roomTurnRanFor,
  roomTurnsRanFor,
} from '../oracles/rooms.js';
import { mentionOf, openRoomFor, seedRoomAgents, setCollectDebounce } from './rooms-setup.js';
import type { RoomAgentSpec } from './rooms-setup.js';

/**
 * The one agent every structural case seats, in `mention-only`.
 *
 * The strictest mode that still answers, chosen so each case's trigger is
 * unambiguous: an `engaged` agent answers a mention AND anything inside its
 * window, so a green would not say which of the two fired.
 */
const ADA: RoomAgentSpec = {
  slug: 'ada',
  displayName: 'Ada',
  description: 'Answers questions about this project in the team channel.',
  responseMode: 'mention-only',
};

/** How long the structural cases give the room to settle after a post. */
const QUIET_MS = 2_000;

/**
 * How long the halt case waits for its scripted turn to actually end after it
 * asks for it — the heartbeat is one second, so this is that plus room.
 */
const WIND_DOWN_QUIET_MS = 2_500;

/**
 * Hard ceiling on one structural room drive, from the subscribe to the last
 * `settle()` — one budget for the whole case, not one per settle call.
 *
 * Generous against measured runs (the slowest, the halt case, takes about 13
 * seconds) because it is a guard against a hang, not a performance target.
 */
const STRUCTURAL_TIMEOUT_MS = 60_000;

/**
 * The gathering window the burst case sets, in ms.
 *
 * Two seconds rather than the shipped 500, because the case asserts that three
 * messages become ONE turn and a 500ms budget would be measuring how fast the
 * harness can make three HTTP round trips. The mechanism under test — one
 * window, opened once, not slid by later arrivals — is unchanged by its length.
 */
const BURST_DEBOUNCE_MS = 2_000;

/** How many messages the burst case sends inside one window. */
const BURST_SIZE = 3;

/**
 * `rooms-addressed-runs-a-turn` — an agent that is named runs a turn, always.
 *
 * The I3 invariant in its cheapest observable form (`room-participation`
 * §10.2.2, restated in `specs/engaged-response-gate/01-ideation.md` §8): being
 * addressed creates an obligation, so a mention must reach the agent whatever
 * else the room is doing. It is the case that has to stay green when the
 * engaged-response gate lands — the gate is scoped to never run on an addressed
 * trigger, and this is what would catch it widening.
 */
export const roomsAddressedRunsATurnCase: EvalCase = {
  id: 'rooms-addressed-runs-a-turn',
  title: 'Rooms — a mentioned agent runs a turn, and the room is charged for exactly one',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'addressed',
      title: 'Addressed',
      agents: [ADA],
      timeoutMs: STRUCTURAL_TIMEOUT_MS,
    });
    try {
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text: `${mentionOf(room, 'ada')} can you confirm the release notes are ready?`,
      });
      const frames = await stream.settle({ quietMs: QUIET_MS });
      return { frames, room };
    } finally {
      stream.close();
    }
  },
  oracles: [
    roomTurnRanFor('ada', 'the mentioned agent ran a turn'),
    agentPostedInRoom('ada', { label: 'the mentioned agent answered in the room' }),
    roomTurnBudgetSpent(1, 'the answer cost exactly one automatic turn'),
  ],
};

/**
 * `rooms-unaddressed-is-free` — nobody was addressed, so nothing ran and
 * nothing was spent.
 *
 * The other half of the addressing matrix, and the half with the money in it:
 * the per-room hourly ceiling is what the next person who DOES address an agent
 * needs, so an untriggered message must not eat it. Three oracles, because
 * "nothing happened" needs to be told apart from "the eval watched the wrong
 * room": the turn oracle reads the indicator, the quiet oracle reads the log,
 * and the budget oracle reads the durable spend rows.
 */
export const roomsUnaddressedIsFreeCase: EvalCase = {
  id: 'rooms-unaddressed-is-free',
  title: 'Rooms — a message that addresses nobody runs no turn and spends no budget',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'unaddressed',
      title: 'Unaddressed',
      agents: [ADA],
      timeoutMs: STRUCTURAL_TIMEOUT_MS,
    });
    try {
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text: 'Thinking out loud: the release notes still need a proof-read before Friday.',
      });
      const frames = await stream.settle({ quietMs: QUIET_MS });
      return { frames, room };
    } finally {
      stream.close();
    }
  },
  oracles: [
    noRoomTurnFor('ada', 'nobody was addressed, so no turn was triggered'),
    agentStayedQuietInRoom('ada', { label: 'the room stayed quiet' }),
    roomSpentNoTurnBudget('the unaddressed message spent nothing from the turn budget'),
  ],
};

/**
 * `rooms-burst-collects-into-one-turn` — three messages inside the gathering
 * window are one turn, not three (A-03 / RP8).
 *
 * A turn answers a MOMENT, not a message. Before the collector existed, three
 * people typing at once bought three model calls that each answered a third of
 * the conversation — so this case is about cost AND about coherence.
 *
 * The budget oracle is the one that would catch a regression nobody could see
 * from the room: a collector that gathered the messages but still reserved a
 * turn per message would produce one visible answer and three spends.
 */
export const roomsBurstCollectsCase: EvalCase = {
  id: 'rooms-burst-collects-into-one-turn',
  title: 'Rooms — a burst of messages collects into one turn, charged once',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    await setCollectDebounce(ctx.baseUrl, BURST_DEBOUNCE_MS);
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'burst',
      title: 'Burst',
      agents: [ADA],
      timeoutMs: STRUCTURAL_TIMEOUT_MS,
    });
    try {
      const mention = mentionOf(room, 'ada');
      for (let index = 1; index <= BURST_SIZE; index += 1) {
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text: `${mention} part ${index} of ${BURST_SIZE}: what do you make of it?`,
        });
      }
      // Settle only once a turn has actually been seen, so a quiet window that
      // expired before the gathering window closed cannot be read as "no turn".
      await stream.settle({
        settleWhen: (collected) => observedTurns(collected).length > 0,
        quietMs: BURST_DEBOUNCE_MS + QUIET_MS,
      });
      // Then give the room a second window to prove no SECOND turn follows —
      // the frames THAT settle collects are the ones the oracles judge, because
      // a case asserting "exactly one turn" has to have waited for a second.
      const frames = await stream.settle({ quietMs: BURST_DEBOUNCE_MS + QUIET_MS });
      return { frames, room };
    } finally {
      stream.close();
    }
  },
  oracles: [
    roomTurnsRanFor('ada', 1, `${BURST_SIZE} messages in one window ran exactly one turn`),
    roomTurnBudgetSpent(1, 'the gathered turn was charged once, not once per message'),
    agentPostedInRoom('ada', { label: 'the gathered turn produced an answer' }),
  ],
};

/**
 * `rooms-halt-stops-and-says-so` — Stop reaches a running turn, and the room
 * says so exactly once (A-16 / RP8, `room-participation` §10.4).
 *
 * Two things are asserted and the second is the one with a rule behind it. The
 * halt must reach a LIVE turn (`stopped >= 1`, which only the route's answer
 * carries), and the room must write ONE `halted` notice — written BEFORE the
 * claims are dropped, because an indicator that vanishes ahead of the entry
 * explaining it is a room going quiet for no visible reason, which
 * `.claude/rules/room-conduct.md` forbids. The notice is damped per room, so
 * "exactly one" is the assertion rather than "at least one".
 *
 * **Test-mode only, and structurally so.** It needs a turn that is still running
 * when Stop is pressed, which the `long-turn` scenario provides deterministically
 * (`POST /api/test/scenario`). A real model would make the same case a race.
 */
export const roomsHaltStopsCase: EvalCase = {
  id: 'rooms-halt-stops-and-says-so',
  title: 'Rooms — Stop interrupts a running turn and the room writes one notice',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    // A turn that keeps working until it is told to stop — otherwise test-mode
    // answers in ~30ms and the halt would race a turn that had already ended.
    const scripted = await selectTestScenario({ baseUrl: ctx.baseUrl, scenario: 'long-turn' });
    if (!scripted) {
      throw new Error('this case needs the test-mode scenario control; it is test-mode only');
    }
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'halt',
      title: 'Halt',
      agents: [ADA],
      timeoutMs: STRUCTURAL_TIMEOUT_MS,
    });
    try {
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text: `${mentionOf(room, 'ada')} start on the long refactor, please.`,
      });
      // Press Stop only once the room is actually showing work — the whole case
      // is about interrupting a live turn, and halting an idle room would pass
      // the notice oracle while proving nothing.
      await waitForRoomFrames(stream, (frames) => observedTurns(frames).length > 0, {
        timeoutMs: 20_000,
      });
      room.notes.stopped = await haltRoom({ baseUrl: ctx.baseUrl, roomId: room.roomId });
      const frames = await stream.settle({ quietMs: QUIET_MS });

      // **Wind the scripted turn down BEFORE this case returns, and wait for it.**
      // A halt interrupts the room's WAIT; the runtime's own stream still closes
      // the ordinary way, and `TestModeRuntime.interruptQuery` answers false
      // because there is no process to signal — so the `long-turn` scenario is
      // still ticking here. Left running, it outlives the eval: the runner
      // disposes the server, closes the sandbox database, and the turn's own
      // completion path then writes into a closed handle and takes the whole run
      // down with an uncaught `The database connection is not open`. Measured,
      // not theorised — that is exactly how this case first failed.
      await finishTestTurns({ baseUrl: ctx.baseUrl });
      await stream.settle({ quietMs: WIND_DOWN_QUIET_MS });
      return { frames, room };
    } finally {
      // Hand the scenario store back the way it was found: it is a module
      // singleton shared by every in-process eval in this runner process, so a
      // scenario chosen here would otherwise be chosen for every case after it.
      await resetTestMode({ baseUrl: ctx.baseUrl });
      stream.close();
    }
  },
  oracles: [
    roomTurnRanFor('ada', 'a turn was running when Stop was pressed'),
    roomScriptNote(
      'stopped',
      (value) => typeof value === 'number' && value >= 1,
      'the halt reached at least one live turn'
    ),
    roomNoticeCount('halted', 1, 'the room said it was stopped, exactly once'),
  ],
};

/** Every structural rooms case, in registration order. */
export const roomsStructuralCases: EvalCase[] = [
  roomsAddressedRunsATurnCase,
  roomsUnaddressedIsFreeCase,
  roomsBurstCollectsCase,
  roomsHaltStopsCase,
];
