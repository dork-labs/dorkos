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
 * - Swapping rungs 3 and 4 (checking `held` before `presence`) turns "somebody
 *   actually working outranks somebody about to" red.
 * - Reading `held[held.length - 1]!` instead of `held[0]!` turns "counts from
 *   the OLDEST wait" red.
 */
import { describe, it, expect } from 'vitest';
import type { ConversationCapabilities } from '../capabilities';
import {
  deriveLaneState,
  laneElapsed,
  LANE_TIMER_FLOOR_MS,
  NO_ASKS,
  type LaneAsk,
  type LaneHeldAuthor,
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
  mentions: true,
  streamHealth: true,
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
  mentions: false,
  streamHealth: false,
  presence: false,
  turnStatus: true,
  asks: true,
};

const NOW = Date.parse('2026-08-18T10:00:00.000Z');

/** A parked prompt, exactly as the fleet-wide stream carries one. */
const ASK: LaneAsk = {
  sessionId: 'session-1',
  cwd: '/projects/meeting-notes',
  interaction: {
    type: 'approval',
    id: 'interaction-1',
    startedAt: NOW - 60_000,
    remainingMs: 540_000,
    timeoutMs: 600_000,
    toolName: 'Bash',
    input: JSON.stringify({ command: 'pnpm verify' }),
    hasSuggestions: false,
  },
};

/** The line the lane builds from it, with no roster to name the agent. */
const ASK_HEADLINE = 'meeting-notes wants to run "pnpm verify"';

/** One agent working, `minutesIn` minutes ago. */
function claim(
  name: string,
  minutesIn: number,
  state: LanePresenceAuthor['state'] = 'working',
  activity: LanePresenceAuthor['activity'] = null
): LanePresenceAuthor {
  return {
    authorId: name.toLowerCase(),
    name,
    state,
    since: new Date(NOW - minutesIn * 60_000).toISOString(),
    activity,
  };
}

/**
 * One agent whose answer to this room has not started, `minutesIn` minutes ago.
 *
 * @param name - What to call it.
 * @param minutesIn - How long the message has been waiting.
 * @param behindTitle - What to call the conversation in the way, or `null` when
 *   this reader cannot see it.
 */
function waiting(name: string, minutesIn: number, behindTitle: string | null): LaneHeldAuthor {
  return {
    authorId: name.toLowerCase(),
    name,
    since: new Date(NOW - minutesIn * 60_000).toISOString(),
    behind: { roomId: 'room-elsewhere', title: behindTitle },
    othersWaiting: false,
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
    held: [],
    turn: null,
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

    expect(state).toEqual({ kind: 'ask', ask: ASK, count: 1, headline: ASK_HEADLINE });
  });

  it('counts the Asks it is not showing', () => {
    const second: LaneAsk = { ...ASK, interaction: { ...ASK.interaction, id: 'interaction-2' } };
    const state = deriveLaneState(input({ asks: [ASK, second] }));

    expect(state).toEqual({ kind: 'ask', ask: ASK, count: 2, headline: ASK_HEADLINE });
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

  it('withholds the stalled rung from a surface that says it elsewhere', () => {
    // **Seeded defect:** drop the `streamHealth` gate on rung 2, and a session —
    // whose status chip under the same box already reports the connection —
    // grows a second alarm about one fact. Run and red.
    const state = deriveLaneState(input({ capabilities: SESSION_CAPABILITIES, stalled: true }));

    expect(state).toEqual({ kind: 'empty' });
  });

  it('names one agent, in the words the room already used', () => {
    const state = deriveLaneState(input({ presence: [claim('Kai', 2)] }));

    expect(state).toEqual({
      kind: 'presence',
      sentence: 'Kai is working on it',
      // With nothing heard, the drawn line IS the sentence.
      line: 'Kai is working on it',
      authorIds: ['kai'],
      since: new Date(NOW - 2 * 60_000).toISOString(),
      late: false,
    });
  });

  it('draws the verb and announces the sentence, in one object', () => {
    // The accessibility contract in its purest form (ADR 260819-022127): the
    // eye moves and the ear does not. If these two ever collapse into one field
    // the announcer becomes chatty — a turn starting a tool every two seconds
    // would re-read the live region 300 times in ten minutes.
    const state = deriveLaneState(
      input({
        presence: [claim('Kai', 2, 'working', { toolName: 'Read', target: 'standup.md' })],
      })
    );

    expect(state).toMatchObject({
      kind: 'presence',
      line: 'Kai is reading standup.md',
      sentence: 'Kai is working on it',
    });
  });

  it('keeps the plain sentence when two agents are working, whatever the oldest is doing', () => {
    // The lane is one line that never wraps, and "Kai and Ana are working on it"
    // cannot carry two verbs — picking one to speak for both is a lie about the
    // other. The peek is where a per-agent answer belongs.
    const state = deriveLaneState(
      input({
        presence: [
          claim('Kai', 3, 'working', { toolName: 'Read', target: 'standup.md' }),
          claim('Ana', 1),
        ],
      })
    );

    expect(state).toMatchObject({
      line: 'Kai and Ana are working on it',
      sentence: 'Kai and Ana are working on it',
    });
  });

  it('keeps the plain sentence once the wait has gone long', () => {
    // `working_late`'s sentence already truncates on a 375 px screen, and its
    // long-wait clause is the one actionable thing in it. The peek still shows
    // a late agent's verb, where there is a second line for it.
    const state = deriveLaneState(
      input({
        presence: [claim('Kai', 12, 'working_late', { toolName: 'Bash', target: 'pnpm test' })],
      })
    );

    expect(state).toMatchObject({
      line: 'Kai is still working — this is taking longer than usual',
      sentence: 'Kai is still working — this is taking longer than usual',
    });
  });

  it('falls back to the room’s own sentence when nothing has been heard', () => {
    // `activityClause` answers `null` rather than "working" precisely so the
    // room can say its own less specific truth here instead of borrowing the
    // session's word.
    expect(deriveLaneState(input({ presence: [claim('Kai', 2)] }))).toMatchObject({
      line: 'Kai is working on it',
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
      line: 'Kai and Ana are still working — this is taking longer than usual',
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

  it('says nothing about held drafts, because the queue panel is their home', () => {
    // There is no `queued` rung. It used to sit below every `turn-*` rung while
    // a queue only ever exists BECAUSE a turn is running, so it could never be
    // reached — a person with two messages held saw no mention of them at all.
    expect(
      deriveLaneState(input({ capabilities: SESSION_CAPABILITIES, turn: turn() }))
    ).toMatchObject({ kind: 'turn-streaming' });

    expect(
      deriveLaneState(input({ capabilities: SESSION_CAPABILITIES, turn: turn({ status: 'idle' }) }))
    ).toEqual({ kind: 'empty' });
  });
});

describe('deriveLaneState — a message that has not started', () => {
  it('says who will pick it up and where they are, counting from the oldest wait', () => {
    // The rung's whole job. The room is named because THIS reader can see it —
    // a reader who cannot gets "another conversation" from the same sentence,
    // and the surface passes `null` rather than guessing.
    const state = deriveLaneState(
      input({ held: [waiting('Mio Clicker PM', 3, '#mio-engagement'), waiting('Ana', 1, null)] })
    );

    expect(state).toEqual({
      kind: 'held',
      sentence: "Mio Clicker PM and Ana will pick this up when they're free",
      authorIds: ['mio clicker pm', 'ana'],
      // **The OLDEST wait**, which is the longest anybody here has been waiting.
      // Reading the last one instead reports the shortest, and the number beside
      // the sentence then understates the problem it exists to describe.
      since: new Date(NOW - 3 * 60_000).toISOString(),
    });
  });

  it('names the conversation in the way when this reader can see it', () => {
    const state = deriveLaneState(
      input({ held: [waiting('Mio Clicker PM', 1, '#mio-engagement')] })
    );

    expect(state).toMatchObject({
      kind: 'held',
      sentence: 'Mio Clicker PM will pick this up when it finishes in #mio-engagement',
    });
  });

  it('says "another conversation" when it cannot', () => {
    const state = deriveLaneState(input({ held: [waiting('Mio Clicker PM', 1, null)] }));

    expect(state).toMatchObject({
      kind: 'held',
      sentence: 'Mio Clicker PM will pick this up when it finishes in another conversation',
    });
  });

  it('lets somebody actually working outrank somebody about to', () => {
    // **Seeded defect:** swap rungs 3 and 4, and a room where one agent is
    // mid-answer reports the OTHER one's wait instead — hiding live work to
    // report a queue, which is the exact trade the deleted `queued` rung was
    // rejected for.
    const state = deriveLaneState(
      input({ presence: [claim('Kai', 2)], held: [waiting('Mio Clicker PM', 5, null)] })
    );

    expect(state).toMatchObject({ kind: 'presence' });
  });

  it('beats an empty lane, which is the case it exists for', () => {
    // The reachable one: the agent is busy ELSEWHERE, so nobody is working here
    // and rung 3 is empty. Without this rung the lane says nothing at all, which
    // is what the old refusal notice was covering for.
    expect(deriveLaneState(input({ held: [waiting('Mio Clicker PM', 1, null)] })).kind).toBe(
      'held'
    );
  });

  it('withholds it from a conversation that carries no presence at all', () => {
    // A session's own composer has no room-mates and no waits: the rung rides
    // `capabilities.presence` because it comes off the same store and the same
    // stream, and a session that turned presence off must not get half of it.
    const state = deriveLaneState(
      input({ capabilities: SESSION_CAPABILITIES, held: [waiting('Mio Clicker PM', 1, null)] })
    );

    expect(state).toEqual({ kind: 'empty' });
  });

  it('counts past the naming limit instead of listing everybody', () => {
    const many = ['A', 'B', 'C', 'D'].map((name) => waiting(name, 1, null));
    expect(deriveLaneState(input({ held: many }))).toMatchObject({
      sentence: "4 agents will pick this up when they're free",
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
