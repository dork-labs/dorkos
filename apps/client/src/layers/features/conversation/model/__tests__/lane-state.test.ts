/**
 * The live lane's priority stack, rung by rung.
 *
 * Ten states share one line, and which one wins is the whole of what this file
 * pins. Three of the orderings are decisions with reasons attached — `ask` over
 * `stalled`, `stalled` over `presence`, and `turn-waiting` surviving beside
 * `ask` — and each has a case here that fails if the order moves.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Swapping rungs 2 and 3 (checking `presence` before `stalled`) turns
 *   "a stream it cannot read outranks who was working" red.
 * - Deleting the `capabilities.turnStatus` guard turns the five capability
 *   cases red.
 * - Returning `presence[presence.length - 1]!` instead of `presence[0]!` turns
 *   "counts from the OLDEST claim" red.
 * - Dropping the ten-second floor in `laneElapsed` turns "no number under ten
 *   seconds" red.
 */
import { describe, it, expect } from 'vitest';
import type { ConversationCapabilities } from '../capabilities';
import {
  deriveLaneState,
  laneElapsed,
  LANE_TIMER_FLOOR_MS,
  NO_ASKS,
  type LaneAsk,
  type LanePresenceAuthor,
  type LaneStateInput,
  type LaneTurn,
} from '../lane-state';

/**
 * The two shipped capability tables, declared here rather than imported.
 *
 * A feature may not import a widget's model (`ROOM_CAPABILITIES` lives in
 * `widgets/room-view`), and importing the session's would tie this suite to a
 * sibling feature for two booleans. What matters to the stack is which flags are
 * on, and the shipped tables are exercised where they are mounted:
 * `RoomLiveLane.test.tsx` for the room's, `ChatPanel.test.tsx` for the session's.
 */
const ROOM_CAPABILITIES: ConversationCapabilities = {
  reactions: true,
  threads: true,
  runWith: false,
  attachments: true,
  toolCards: false,
  mentions: true,
  presence: true,
  turnStatus: false,
  asks: true,
};

/** The session's table: a turn of its own, and nobody else's presence. */
const SESSION_CAPABILITIES: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: true,
  attachments: true,
  toolCards: true,
  mentions: false,
  presence: false,
  turnStatus: true,
  asks: true,
};

const NOW = Date.parse('2026-08-18T10:00:00.000Z');

/** A parked prompt, as P3 will hand one over. */
const ASK: LaneAsk = {
  sessionId: 'session-1',
  interactionId: 'interaction-1',
  headline: 'Meeting Notes needs your OK to run pnpm verify',
};

/** One agent working, `minutesIn` minutes ago. */
function claim(
  name: string,
  minutesIn: number,
  state: LanePresenceAuthor['state'] = 'working'
): LanePresenceAuthor {
  return {
    authorId: name.toLowerCase(),
    name,
    state,
    since: new Date(NOW - minutesIn * 60_000).toISOString(),
  };
}

/** A session's turn, streaming unless told otherwise. */
function turn(overrides: Partial<LaneTurn> = {}): LaneTurn {
  return {
    status: 'streaming',
    isWaitingForUser: false,
    waitingType: 'approval',
    operationProgress: null,
    systemStatus: null,
    elapsed: '1m 04s',
    activity: null,
    tokens: '~3.2k tokens',
    isBypass: false,
    showComplete: false,
    lastElapsed: '2m 10s',
    lastTokens: '~8.0k tokens',
    ...overrides,
  };
}

/** The whole input, quiet unless a case says otherwise. */
function input(overrides: Partial<LaneStateInput> = {}): LaneStateInput {
  return {
    capabilities: ROOM_CAPABILITIES,
    asks: NO_ASKS,
    stalled: false,
    presence: [],
    turn: null,
    queueDepth: 0,
    ...overrides,
  };
}

describe('deriveLaneState — the priority stack', () => {
  it('says nothing at all when nothing is happening', () => {
    expect(deriveLaneState(input())).toEqual({ kind: 'empty' });
  });

  it('puts an Ask above everything, a stalled stream included', () => {
    // The rung that earns its place: an Ask already in hand is still true and
    // still answerable when the wire goes quiet — its countdown runs off
    // `startedAt`, not off the stream. A stalled line hiding a live Ask is the
    // exact failure this programme exists to remove.
    const state = deriveLaneState(
      input({ asks: [ASK], stalled: true, presence: [claim('Kai', 2)] })
    );

    expect(state).toEqual({ kind: 'ask', ask: ASK, count: 1 });
  });

  it('counts the Asks it is not showing', () => {
    const second: LaneAsk = { ...ASK, interactionId: 'interaction-2' };
    const state = deriveLaneState(input({ asks: [ASK, second] }));

    expect(state).toEqual({ kind: 'ask', ask: ASK, count: 2 });
  });

  it('withholds the Ask rung from a conversation that cannot hold one', () => {
    const noAsks = { ...ROOM_CAPABILITIES, asks: false };
    const state = deriveLaneState(input({ capabilities: noAsks, asks: [ASK] }));

    expect(state).toEqual({ kind: 'empty' });
  });

  it('lets a stream it cannot read outrank who was working', () => {
    // `specs/room-presence` §5.4: a client that cannot read the stream must not
    // claim to know who is working. The presence store is CLEARED on a stall as
    // well; this rung is the belt to that clear's braces.
    const state = deriveLaneState(input({ stalled: true, presence: [claim('Kai', 2)] }));

    expect(state).toEqual({ kind: 'stalled' });
  });

  it('reports a stalled stream on a surface with no presence at all', () => {
    // `stalled` is the one rung with no capability gate: every surface has a
    // stream, and one that has stopped is worth saying wherever it happens.
    const state = deriveLaneState(input({ capabilities: SESSION_CAPABILITIES, stalled: true }));

    expect(state).toEqual({ kind: 'stalled' });
  });

  it('names one agent, in the words the room already used', () => {
    const state = deriveLaneState(input({ presence: [claim('Kai', 2)] }));

    expect(state).toEqual({
      kind: 'presence',
      sentence: 'Kai is working on it',
      authorIds: ['kai'],
      since: new Date(NOW - 2 * 60_000).toISOString(),
      late: false,
    });
  });

  it('names up to three, and counts past that', () => {
    const three = [claim('Kai', 3), claim('Ana', 2), claim('Sam', 1)];
    expect(deriveLaneState(input({ presence: three })).kind).toBe('presence');
    expect(deriveLaneState(input({ presence: three }))).toMatchObject({
      sentence: 'Kai, Ana and Sam are working on it',
    });

    // The fourth is what would wrap the line, so past three the names move into
    // the peek and the sentence counts instead.
    const four = [...three, claim('Rae', 1)];
    expect(deriveLaneState(input({ presence: four }))).toMatchObject({
      sentence: '4 agents are working on it',
      authorIds: ['kai', 'ana', 'sam', 'rae'],
    });
  });

  it('counts from the OLDEST claim, and takes its state as the line’s', () => {
    // The oldest claim is what the elapsed time measures and the one that
    // crosses the server's late threshold first, so it — not the newest — is
    // what the sentence speaks for.
    const state = deriveLaneState(
      input({ presence: [claim('Kai', 12, 'working_late'), claim('Ana', 1)] })
    );

    expect(state).toEqual({
      kind: 'presence',
      sentence: 'Kai and Ana are still working — this is taking longer than usual',
      authorIds: ['kai', 'ana'],
      since: new Date(NOW - 12 * 60_000).toISOString(),
      late: true,
    });
  });

  it('says a long wait is a long wait past the naming limit too', () => {
    const state = deriveLaneState(
      input({
        presence: [
          claim('Kai', 20, 'working_late'),
          claim('Ana', 3),
          claim('Sam', 2),
          claim('Rae', 1),
        ],
      })
    );

    expect(state).toMatchObject({
      sentence: '4 agents are still working — this is taking longer than usual',
      late: true,
    });
  });

  it('withholds presence from a conversation that has none — a session', () => {
    const state = deriveLaneState(
      input({ capabilities: SESSION_CAPABILITIES, presence: [claim('Kai', 2)] })
    );

    expect(state).toEqual({ kind: 'empty' });
  });

  it('reports a turn parked on the person, with no prompt object in hand', () => {
    // Rung 4 is NOT rung 1 with the DTO missing: it is "this session's turn is
    // parked" in a state the projector reported with nothing to answer —
    // a capability hold, or a runtime that said `blocked` and sent no prompt.
    // Collapsing the two would make this one silently invisible.
    const state = deriveLaneState(
      input({
        capabilities: SESSION_CAPABILITIES,
        turn: turn({ isWaitingForUser: true, waitingType: 'question' }),
      })
    );

    expect(state).toEqual({ kind: 'turn-waiting', waitingType: 'question', elapsed: '1m 04s' });
  });

  it('reports a long operation, whatever the turn is doing', () => {
    const state = deriveLaneState(
      input({
        capabilities: SESSION_CAPABILITIES,
        turn: turn({
          status: 'idle',
          operationProgress: { message: 'Compacting context…', determinate: true, percent: 65 },
        }),
      })
    );

    expect(state).toEqual({
      kind: 'turn-progress',
      message: 'Compacting context…',
      determinate: true,
      percent: 65,
    });
  });

  it('names a nameless operation rather than drawing a blank one', () => {
    const state = deriveLaneState(
      input({
        capabilities: SESSION_CAPABILITIES,
        turn: turn({
          operationProgress: { message: null, determinate: false, percent: null },
        }),
      })
    );

    expect(state).toMatchObject({ kind: 'turn-progress', message: 'Working…', percent: null });
  });

  it('reports a runtime event under the operation and over the turn', () => {
    const state = deriveLaneState(
      input({
        capabilities: SESSION_CAPABILITIES,
        turn: turn({ systemStatus: { message: 'Running hook "format"…' } }),
      })
    );

    expect(state).toEqual({ kind: 'turn-system', message: 'Running hook "format"…' });
  });

  it('phrases a turn in flight through the one honesty ladder', () => {
    const state = deriveLaneState(
      input({
        capabilities: SESSION_CAPABILITIES,
        turn: turn({ activity: { toolName: 'Bash', target: 'pnpm verify' } }),
      })
    );

    expect(state).toEqual({
      kind: 'turn-streaming',
      verb: 'Running pnpm verify…',
      // The label IS the key, so the crossfade plays on a real change and stays
      // still while the clock beside it ticks.
      verbKey: 'Running pnpm verify…',
      elapsed: '1m 04s',
      tokens: '~3.2k tokens',
      isBypass: false,
    });
  });

  it('carries the permission-stops-off warning through the turn', () => {
    const state = deriveLaneState(
      input({ capabilities: SESSION_CAPABILITIES, turn: turn({ isBypass: true }) })
    );

    expect(state).toMatchObject({ kind: 'turn-streaming', isBypass: true });
  });

  it('shows the finished turn’s summary, from the readings it snapshotted', () => {
    const state = deriveLaneState(
      input({
        capabilities: SESSION_CAPABILITIES,
        turn: turn({ status: 'idle', showComplete: true }),
      })
    );

    expect(state).toEqual({ kind: 'turn-complete', elapsed: '2m 10s', tokens: '~8.0k tokens' });
  });

  it('withholds every turn rung from a conversation with no turn of its own', () => {
    // A room's capability table has `turnStatus: false`, and the five rungs it
    // gates go with it — a channel has no elapsed clock, no token count and no
    // permission mode to warn about.
    for (const parked of [
      turn({ isWaitingForUser: true }),
      turn({ operationProgress: { message: 'Compacting…', determinate: false, percent: null } }),
      turn({ systemStatus: { message: 'Running hook…' } }),
      turn(),
      turn({ status: 'idle', showComplete: true }),
    ]) {
      expect(deriveLaneState(input({ capabilities: ROOM_CAPABILITIES, turn: parked }))).toEqual({
        kind: 'empty',
      });
    }
  });

  it('reports held drafts below every turn rung, and only when there are some', () => {
    expect(
      deriveLaneState(input({ capabilities: SESSION_CAPABILITIES, queueDepth: 3, turn: turn() }))
    ).toMatchObject({ kind: 'turn-streaming' });

    expect(
      deriveLaneState(
        input({
          capabilities: SESSION_CAPABILITIES,
          queueDepth: 3,
          turn: turn({ status: 'idle' }),
        })
      )
    ).toEqual({ kind: 'queued', depth: 3 });

    expect(deriveLaneState(input({ capabilities: SESSION_CAPABILITIES, queueDepth: 0 }))).toEqual({
      kind: 'empty',
    });
  });
});

describe('laneElapsed — the ten-second floor', () => {
  it('draws no number at all while a claim is young', () => {
    // A timer that starts at `0s` draws the eye for nothing, and the eye is the
    // whole budget a line above the composer has (design record).
    const since = new Date(NOW).toISOString();

    expect(laneElapsed(since, NOW)).toBeNull();
    expect(laneElapsed(since, NOW + LANE_TIMER_FLOOR_MS - 1)).toBeNull();
  });

  it('starts counting exactly at ten seconds, in the one elapsed vocabulary', () => {
    const since = new Date(NOW).toISOString();

    expect(laneElapsed(since, NOW + LANE_TIMER_FLOOR_MS)).toBe('10s');
    expect(laneElapsed(since, NOW + 42_000)).toBe('42s');
    expect(laneElapsed(since, NOW + 12 * 60_000)).toBe('12m');
    expect(laneElapsed(since, NOW + 3 * 3_600_000)).toBe('3h');
  });

  it('says nothing rather than counting backwards from a clock that disagrees', () => {
    // `since` is the SERVER's wall clock and `now` is this browser's, so a
    // machine running fast can produce a negative age. Below the floor either
    // way, which is the honest answer.
    expect(laneElapsed(new Date(NOW + 60_000).toISOString(), NOW)).toBeNull();
    expect(laneElapsed('not a date', NOW)).toBeNull();
  });
});
