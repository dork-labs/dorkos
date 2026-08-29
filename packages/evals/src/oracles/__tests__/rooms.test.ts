/**
 * Unit tests for the room oracles, over hand-built room frames.
 *
 * Each oracle owes a drill (README, "a new oracle ships with a drill"), and for
 * these the drill is expressible right here rather than as a recipe: a room
 * oracle reads FRAMES, so the seed that should turn it red is a frame set, and
 * every oracle below is shown going green on the frames that should pass it and
 * red on the ones that should not. The one oracle that cannot be drilled from
 * frames — the budget oracle, which reads SQLite — gets a real sandbox database.
 */
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, runMigrations, roomTurnSpend } from '@dorkos/db';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { OracleContext, RoomFacts } from '../../types.js';
import { emptyApprovalLog } from '../../types.js';
import {
  agentPostCount,
  agentPostedInRoom,
  agentReactedInRoom,
  agentStayedQuietInRoom,
  noRoomEntryContains,
  noRoomTurnFor,
  observedEntries,
  observedTurns,
  roomNoticeCount,
  roomScriptNote,
  roomSpentNoTurnBudget,
  roomTurnBudgetSpent,
  roomTurnRanFor,
  roomTurnsRanFor,
  somethingVisibleLanded,
} from '../rooms.js';

const ADA = 'author-ada';
const OPERATOR = 'author-operator';

/** The room facts a case's script would have recorded. */
function facts(notes: Record<string, unknown> = {}): RoomFacts {
  return {
    roomId: 'room-1',
    members: {
      [OPERATOR]: { authorId: OPERATOR, handle: null, kind: 'human', responseMode: 'always' },
      [ADA]: { authorId: ADA, handle: 'ada', kind: 'agent', responseMode: 'mention-only' },
    },
    agents: { ada: ADA },
    operatorAuthorId: OPERATOR,
    notes,
  };
}

/** One `entry` frame. */
function entry(opts: {
  id: string;
  authorId: string;
  text: string;
  kind?: string;
  notice?: string;
  /** Who a notice is ABOUT, which is not who wrote it — the system author does. */
  subjectAuthorId?: string;
}): SseFrame {
  return {
    event: 'entry',
    data: {
      type: 'entry',
      seq: 1,
      entry: {
        id: opts.id,
        authorId: opts.authorId,
        kind: opts.kind ?? 'post',
        body: {
          text: opts.text,
          ...(opts.notice ? { notice: opts.notice } : {}),
          ...(opts.subjectAuthorId ? { subjectAuthorId: opts.subjectAuthorId } : {}),
        },
      },
    },
  };
}

/** One presence `signal` frame. */
function presence(opts: { authorId: string; entryId: string; state: string }): SseFrame {
  return {
    event: 'signal',
    data: {
      type: 'signal',
      signal: 'progress',
      authorId: opts.authorId,
      state: opts.state,
      entryId: opts.entryId,
      at: '2026-08-15T00:00:00.000Z',
    },
  };
}

/**
 * One `reaction` frame — the entry's WHOLE current set, matching
 * `RoomReactionEventSchema`. `authorIds: []` is how a reaction is taken back.
 */
function reaction(opts: { entryId: string; emoji: string; authorIds: string[] }): SseFrame {
  return {
    event: 'reaction',
    data: {
      type: 'reaction',
      entryId: opts.entryId,
      reactions:
        opts.authorIds.length === 0
          ? []
          : [
              {
                emoji: opts.emoji,
                authorIds: opts.authorIds,
                firstAt: '2026-08-15T00:00:00.000Z',
              },
            ],
    },
  };
}

/**
 * An oracle context over the given frames.
 *
 * `room` is `null` — not `undefined` — for the no-room case: an explicit
 * `undefined` would take the DEFAULT parameter and quietly hand the oracle a
 * room, which is how the "fails when there is no room" test first passed while
 * asserting nothing.
 */
function ctx(frames: SseFrame[], room: RoomFacts | null = facts()): OracleContext {
  return {
    sandbox: { dorkHome: '/nowhere/.dork', projectCwd: '/nowhere/project' },
    baseUrl: 'http://127.0.0.1:0',
    sessionId: 'session-1',
    frames,
    approvals: emptyApprovalLog(),
    ...(room ? { room } : {}),
  };
}

/** A turn: the trigger, the indicator, the answer, the release. */
const ONE_TURN: SseFrame[] = [
  entry({ id: 'e1', authorId: OPERATOR, text: '@ada what is up?' }),
  presence({ authorId: ADA, entryId: 'e1', state: 'working' }),
  entry({ id: 'e2', authorId: ADA, text: 'All quiet on the importer.' }),
  presence({ authorId: ADA, entryId: 'e1', state: 'done' }),
];

describe('observedTurns', () => {
  it('counts one turn per (agent, trigger) however many indicators it republishes', () => {
    const republished = [
      ...ONE_TURN,
      presence({ authorId: ADA, entryId: 'e1', state: 'working' }),
      presence({ authorId: ADA, entryId: 'e1', state: 'working_late' }),
    ];
    expect(observedTurns(republished)).toEqual([{ authorId: ADA, entryId: 'e1' }]);
  });

  it('counts two turns when two different messages triggered them', () => {
    const twice = [
      ...ONE_TURN,
      presence({ authorId: ADA, entryId: 'e3', state: 'working' }),
      presence({ authorId: ADA, entryId: 'e3', state: 'done' }),
    ];
    expect(observedTurns(twice)).toHaveLength(2);
  });

  it('ignores the snapshot, which is the room before the drive posted anything', () => {
    const withSnapshot: SseFrame[] = [
      { event: 'snapshot', data: { room: {}, entries: [{ id: 'old' }], cursor: 3 } },
      ...ONE_TURN,
    ];
    expect(observedEntries(withSnapshot).map((e) => e.id)).toEqual(['e1', 'e2']);
  });
});

describe('turn oracles', () => {
  it('roomTurnRanFor passes on an indicator and reds when none names the agent', async () => {
    await expect(roomTurnRanFor('ada')(ctx(ONE_TURN))).resolves.toMatchObject({ passed: true });
    const noIndicator = ONE_TURN.filter((f) => f.event !== 'signal');
    await expect(roomTurnRanFor('ada')(ctx(noIndicator))).resolves.toMatchObject({ passed: false });
  });

  it('noRoomTurnFor is the exact inverse, so neither can pass vacuously', async () => {
    await expect(noRoomTurnFor('ada')(ctx(ONE_TURN))).resolves.toMatchObject({ passed: false });
    await expect(noRoomTurnFor('ada')(ctx([]))).resolves.toMatchObject({ passed: true });
  });

  it('roomTurnsRanFor(1) reds when a second turn ran — the burst regression', async () => {
    const twice = [
      ...ONE_TURN,
      presence({ authorId: ADA, entryId: 'e3', state: 'working' }),
      entry({ id: 'e4', authorId: ADA, text: 'And again.' }),
    ];
    await expect(roomTurnsRanFor('ada', 1)(ctx(ONE_TURN))).resolves.toMatchObject({ passed: true });
    await expect(roomTurnsRanFor('ada', 1)(ctx(twice))).resolves.toMatchObject({ passed: false });
  });

  it('fails rather than passes when the case collected no room at all', async () => {
    const result = await roomTurnRanFor('ada')(ctx(ONE_TURN, null));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('roomScript');
  });
});

describe('what was said', () => {
  it('agentPostedInRoom matches on the text and on the room the server minted', async () => {
    await expect(agentPostedInRoom('ada')(ctx(ONE_TURN))).resolves.toMatchObject({ passed: true });
    await expect(
      agentPostedInRoom('ada', { matches: (text) => text.includes('importer') })(ctx(ONE_TURN))
    ).resolves.toMatchObject({ passed: true });
    await expect(
      agentPostedInRoom('ada', { matches: (text) => text.includes('redis') })(ctx(ONE_TURN))
    ).resolves.toMatchObject({ passed: false });
    await expect(
      agentPostedInRoom('ada', {
        matches: (_text, room) => room.members[ADA]?.handle === 'ada',
      })(ctx(ONE_TURN))
    ).resolves.toMatchObject({ passed: true });
  });

  it('agentReactedInRoom passes on a standing reaction and reds when there is none', async () => {
    const reacted = [...ONE_TURN, reaction({ entryId: 'e1', emoji: '✅', authorIds: [ADA] })];
    await expect(
      agentReactedInRoom('ada', { entryIdNote: 'ackEntryId' })(
        ctx(reacted, facts({ ackEntryId: 'e1' }))
      )
    ).resolves.toMatchObject({ passed: true });
    await expect(
      agentReactedInRoom('ada', { entryIdNote: 'ackEntryId' })(
        ctx(ONE_TURN, facts({ ackEntryId: 'e1' }))
      )
    ).resolves.toMatchObject({ passed: false });
  });

  it('agentReactedInRoom reads only the LAST frame for the entry, not every one that ever arrived', async () => {
    const tookItBack = [
      ...ONE_TURN,
      reaction({ entryId: 'e1', emoji: '✅', authorIds: [ADA] }),
      reaction({ entryId: 'e1', emoji: '✅', authorIds: [] }),
    ];
    await expect(
      agentReactedInRoom('ada', { entryIdNote: 'ackEntryId' })(
        ctx(tookItBack, facts({ ackEntryId: 'e1' }))
      )
    ).resolves.toMatchObject({ passed: false });
  });

  it('agentReactedInRoom checks WHO reacted, not merely that somebody did', async () => {
    // Pins the subject: mutating `reactors.has(authorId)` to `reactors.size > 0`
    // would still pass here, because a reaction landed — just not from the
    // agent the oracle was asked about.
    const someoneElseReacted = [
      ...ONE_TURN,
      reaction({ entryId: 'e1', emoji: '✅', authorIds: [OPERATOR] }),
    ];
    await expect(
      agentReactedInRoom('ada', { entryIdNote: 'ackEntryId' })(
        ctx(someoneElseReacted, facts({ ackEntryId: 'e1' }))
      )
    ).resolves.toMatchObject({ passed: false });
  });

  it('agentReactedInRoom checks WHICH entry was reacted to, not merely that the agent reacted somewhere', async () => {
    // Pins the entry: deleting the `entryId !==` filter in `reactorsOn` would
    // still pass here, because ada reacted to SOMETHING — just not to the
    // message the script recorded as the one asking for acknowledgment.
    const reactedOnTheWrongEntry = [
      ...ONE_TURN,
      reaction({ entryId: 'e2', emoji: '✅', authorIds: [ADA] }),
    ];
    await expect(
      agentReactedInRoom('ada', { entryIdNote: 'ackEntryId' })(
        ctx(reactedOnTheWrongEntry, facts({ ackEntryId: 'e1' }))
      )
    ).resolves.toMatchObject({ passed: false });
  });

  it('agentReactedInRoom fails loudly when the script recorded no entry id to check', async () => {
    const result = await agentReactedInRoom('ada', { entryIdNote: 'ackEntryId' })(ctx(ONE_TURN));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('ackEntryId');
  });

  it('agentStayedQuietInRoom judges only what came after the recorded boundary', async () => {
    const restraint = [
      ...ONE_TURN,
      entry({ id: 'e5', authorId: OPERATOR, text: 'Kai: retro at 3?' }),
    ];
    // Without a boundary the agent's own (correct) answer reads as noise.
    await expect(agentStayedQuietInRoom('ada')(ctx(restraint))).resolves.toMatchObject({
      passed: false,
    });
    await expect(
      agentStayedQuietInRoom('ada', { afterNote: 'windowOpenedBy' })(
        ctx(restraint, facts({ windowOpenedBy: 'e2' }))
      )
    ).resolves.toMatchObject({ passed: true });
    // And it reds when the agent DID chime in after the boundary.
    const chimedIn = [...restraint, entry({ id: 'e6', authorId: ADA, text: 'I can book a room!' })];
    await expect(
      agentStayedQuietInRoom('ada', { afterNote: 'windowOpenedBy' })(
        ctx(chimedIn, facts({ windowOpenedBy: 'e2' }))
      )
    ).resolves.toMatchObject({ passed: false });
  });

  it('a missing boundary note fails loudly instead of judging the whole room', async () => {
    const result = await agentStayedQuietInRoom('ada', { afterNote: 'windowOpenedBy' })(
      ctx(ONE_TURN)
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('windowOpenedBy');
  });

  it('roomNoticeCount counts only notices carrying the code', async () => {
    const halted = [
      ...ONE_TURN,
      entry({ id: 'n1', authorId: OPERATOR, text: 'Stopped.', kind: 'notice', notice: 'halted' }),
      entry({ id: 'n2', authorId: OPERATOR, text: 'Busy.', kind: 'notice', notice: 'agent_busy' }),
    ];
    await expect(roomNoticeCount('halted', 1)(ctx(halted))).resolves.toMatchObject({
      passed: true,
    });
    await expect(roomNoticeCount('halted', 1)(ctx(ONE_TURN))).resolves.toMatchObject({
      passed: false,
    });
  });

  it('noRoomEntryContains reads every entry, whoever wrote it', async () => {
    const leaked = [...ONE_TURN, entry({ id: 'e9', authorId: ADA, text: 'token: CANARY-1' })];
    await expect(noRoomEntryContains('CANARY-1')(ctx(ONE_TURN))).resolves.toMatchObject({
      passed: true,
    });
    await expect(noRoomEntryContains('CANARY-1')(ctx(leaked))).resolves.toMatchObject({
      passed: false,
    });
  });

  it('roomScriptNote judges what the script recorded', async () => {
    const oracle = roomScriptNote('stopped', (v) => typeof v === 'number' && v >= 1, 'stopped one');
    await expect(oracle(ctx([], facts({ stopped: 1 })))).resolves.toMatchObject({ passed: true });
    await expect(oracle(ctx([], facts({ stopped: 0 })))).resolves.toMatchObject({ passed: false });
    await expect(oracle(ctx([], facts()))).resolves.toMatchObject({ passed: false });
  });
});

describe('the turn-budget oracles', () => {
  it('read the room_turn_spend rows this room wrote, and no other room’s', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'evals-rooms-oracle-'));
    try {
      const dorkHome = path.join(root, '.dork');
      await mkdir(dorkHome, { recursive: true });
      const db = createDb(path.join(dorkHome, 'dork.db'));
      runMigrations(db);
      db.insert(roomTurnSpend).values({ roomId: 'room-1', at: Date.now() }).run();
      db.insert(roomTurnSpend).values({ roomId: 'room-2', at: Date.now() }).run();
      db.$client.close();

      const context: OracleContext = {
        ...ctx([]),
        sandbox: { dorkHome, projectCwd: path.join(root, 'project') },
      };
      await expect(roomTurnBudgetSpent(1)(context)).resolves.toMatchObject({ passed: true });
      await expect(roomSpentNoTurnBudget()(context)).resolves.toMatchObject({ passed: false });
      await expect(roomTurnBudgetSpent(2)(context)).resolves.toMatchObject({ passed: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('says nothing was spent when the table is empty, and fails on an unreadable database', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'evals-rooms-oracle-'));
    try {
      const dorkHome = path.join(root, '.dork');
      await mkdir(dorkHome, { recursive: true });
      const db = createDb(path.join(dorkHome, 'dork.db'));
      runMigrations(db);
      db.$client.close();
      const context: OracleContext = {
        ...ctx([]),
        sandbox: { dorkHome, projectCwd: path.join(root, 'project') },
      };
      await expect(roomSpentNoTurnBudget()(context)).resolves.toMatchObject({ passed: true });

      // A sandbox with no database at all must FAIL rather than read as free:
      // "nothing was spent" and "nothing could be read" are different answers.
      const missing: OracleContext = {
        ...ctx([]),
        sandbox: { dorkHome: path.join(root, 'gone'), projectCwd: root },
      };
      await expect(roomSpentNoTurnBudget()(missing)).resolves.toMatchObject({ passed: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const BO = 'author-bo';
const SYSTEM = 'author-system';

/** Room facts seating a SECOND agent, for the cases that must tell them apart. */
function factsWithBo(notes: Record<string, unknown> = {}): RoomFacts {
  const base = facts(notes);
  return {
    ...base,
    members: {
      ...base.members,
      [BO]: { authorId: BO, handle: 'bo', kind: 'agent', responseMode: 'mention-only' },
    },
    agents: { ...base.agents, bo: BO },
  };
}

describe('agentPostCount', () => {
  it('passes on the exact count', async () => {
    const result = await agentPostCount('ada', 1)(ctx(ONE_TURN));
    expect(result.passed).toBe(true);
  });

  it('fails when the agent said it in three messages instead of one', async () => {
    // The shape `rooms.maxPostsPerTurn` bounds, and the one an oracle can see
    // without a judge model.
    const frames = [
      ...ONE_TURN,
      entry({ id: 'e3', authorId: ADA, text: 'Also: the CSV fix shipped.' }),
      entry({ id: 'e4', authorId: ADA, text: 'And Priya is on call.' }),
    ];
    const result = await agentPostCount('ada', 1)(ctx(frames));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('observed 3');
  });

  it('fails when it said nothing at all', async () => {
    const result = await agentPostCount('ada', 1)(ctx([ONE_TURN[0]!]));
    expect(result.passed).toBe(false);
  });

  it('does not count NOTICES as the agent speaking', async () => {
    // The room's own voice is not the agent saying something, and a notice
    // carries the agent's id in `subjectAuthorId` rather than in `authorId` —
    // so counting by author is right and this pins that it stays that way.
    const frames = [
      ONE_TURN[0]!,
      entry({
        id: 'n1',
        authorId: SYSTEM,
        kind: 'notice',
        notice: 'agent_declined',
        subjectAuthorId: ADA,
        text: 'Ada read this and did not reply.',
      }),
    ];
    const result = await agentPostCount('ada', 0)(ctx(frames));
    expect(result.passed).toBe(true);
  });

  it('fails honestly when the case collected no room', async () => {
    const result = await agentPostCount('ada', 1)(ctx(ONE_TURN, null));
    expect(result.passed).toBe(false);
  });
});

describe('somethingVisibleLanded', () => {
  /** The trigger and the indicator, with nothing to show for them. */
  const NOTHING: SseFrame[] = [
    entry({ id: 'e1', authorId: OPERATOR, text: '@ada what did Priya say?' }),
    presence({ authorId: ADA, entryId: 'e1', state: 'working' }),
    presence({ authorId: ADA, entryId: 'e1', state: 'done' }),
  ];

  it('passes on a post', async () => {
    expect((await somethingVisibleLanded('ada')(ctx(ONE_TURN))).passed).toBe(true);
  });

  it('passes on a standing reaction', async () => {
    const frames = [...NOTHING, reaction({ entryId: 'e1', emoji: '✅', authorIds: [ADA] })];
    expect((await somethingVisibleLanded('ada')(ctx(frames))).passed).toBe(true);
  });

  it('passes on the room writing the decline line', async () => {
    const frames = [
      ...NOTHING,
      entry({
        id: 'n1',
        authorId: SYSTEM,
        kind: 'notice',
        notice: 'agent_declined',
        subjectAuthorId: ADA,
        text: 'Ada read this and did not reply.',
      }),
    ];
    expect((await somethingVisibleLanded('ada')(ctx(frames))).passed).toBe(true);
  });

  it('FAILS when the indicator went with nothing to show — the outcome it exists for', async () => {
    const result = await somethingVisibleLanded('ada')(ctx(NOTHING));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('posted nothing');
  });

  it('FAILS on a reaction that was taken back', async () => {
    // A reaction frame carries the entry's COMPLETE current set, so successive
    // frames are states rather than events. Folding them together reads
    // "reacted and took it back" as "reacted" — which this oracle did before
    // `reactorsAnywhere`, and which leaves a reader looking at an empty message.
    const frames = [
      ...NOTHING,
      reaction({ entryId: 'e1', emoji: '✅', authorIds: [ADA] }),
      reaction({ entryId: 'e1', emoji: '✅', authorIds: [] }),
    ];
    expect((await somethingVisibleLanded('ada')(ctx(frames))).passed).toBe(false);
  });

  it('FAILS when the decline line was about a DIFFERENT agent', async () => {
    // The reason `subjectAuthorId` is read at all. A room seating two agents
    // writes a line naming one of them, and "the room said something" is not
    // "the room said something about the agent this case is asking about".
    const frames = [
      ...NOTHING,
      entry({
        id: 'n1',
        authorId: SYSTEM,
        kind: 'notice',
        notice: 'agent_declined',
        subjectAuthorId: BO,
        text: 'Bo read this and did not reply.',
      }),
    ];
    const result = await somethingVisibleLanded('ada')(ctx(frames, factsWithBo()));
    expect(result.passed).toBe(false);
  });

  it("FAILS when somebody ELSE's reaction is the only one standing", async () => {
    const frames = [...NOTHING, reaction({ entryId: 'e1', emoji: '✅', authorIds: [BO] })];
    const result = await somethingVisibleLanded('ada')(ctx(frames, factsWithBo()));
    expect(result.passed).toBe(false);
  });

  it('fails honestly when the case collected no room', async () => {
    expect((await somethingVisibleLanded('ada')(ctx(ONE_TURN, null))).passed).toBe(false);
  });
});
