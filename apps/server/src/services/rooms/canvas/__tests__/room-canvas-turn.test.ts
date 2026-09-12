/**
 * One room turn, end to end: a `ui_command` off the turn's own stream becomes a
 * row, a frame and one line in the room's log — and never two of any of them
 * (spec `room-canvas` §5.5, §6.2).
 *
 * **The REAL runner and the REAL projector.** Only the dispatcher is stubbed,
 * because a real one needs a model; everything the assertions are about — the
 * collector's tap, the per-turn ledger, `finishTurn` in the `finally` — is the
 * code that ships. The room service is real too, over a real SQLite database, so
 * "one row" is read out of the table rather than off a spy.
 *
 * Every case here uses `json` content deliberately. It has no dedupe key, so
 * nothing would quietly absorb a second write: if the tap applied a stamped
 * event as well as the handler, this file would see two rows rather than one
 * refreshed one.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Dropping the `event.applied === undefined` guard on the tap reddens "applies
 *   a stamped event exactly once" with two rows.
 * - Moving `finishTurn` out of the `finally` and into the success path reddens
 *   "a turn the ceiling gave up on still reports what it put on the table".
 * - Composing the coalesced line from the tap's observations rather than the
 *   service's ledger reddens "one line naming both operations".
 *
 * @module server/services/rooms/canvas/tests/room-canvas-turn
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import type { RoomEntry, RoomEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomTurnRequest } from '../../room-trigger.js';

/** The runtime capabilities the stub registry declares. Enough to take a turn. */
const DECLARED_CAPABILITIES = {
  logBackedHistory: false,
  nativeContext: [],
  settings: { configSection: 'claudeCode', supportsEffort: true, sections: [] },
  permissionModes: {
    supported: true,
    default: 'default',
    values: [{ id: 'default', label: 'Default', description: '', stop: 'ask' }],
  },
};

vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    persistSessionRuntime: () => Promise.resolve(true),
    getSessionSettings: () => Promise.resolve(null),
    resolveSessionRuntime: () => Promise.resolve({ type: 'claude-code', bound: false }),
    get: () => ({
      getCapabilities: () => DECLARED_CAPABILITIES,
      acquireLock: () => true,
      releaseLock: () => undefined,
      sendMessage: () => undefined,
      interruptQuery: () => Promise.resolve(mockInterruptReceipt('not-running')),
      getInternalSessionId: () => undefined,
    }),
    has: () => true,
    getDefaultType: () => 'claude-code',
  },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: async () => null }));

let runtimesConfig: UserConfig['runtimes'] = USER_CONFIG_DEFAULTS.runtimes;
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'runtimes' ? runtimesConfig : undefined),
  },
}));

/** The projector the stub is handed, as this file drives it. */
interface TestProjector {
  ingest: (event: Record<string, unknown>) => { seq: number };
}

/** What the runner hands the dispatcher, as this file inspects it. */
interface TriggerCall {
  sessionId: string;
  projector: TestProjector;
  onTurnStart?: (seq: number) => void;
  runtime: { getInternalSessionId: (sessionId: string) => string | undefined };
  roomTurn?: { roomId: string; authorId: string; turnId: string };
}

/** What the stubbed dispatch does with the projector it is handed. */
let turnBehaviour: (opts: TriggerCall) => { accepted: boolean; canonicalId?: string };
/** Every dispatch this file's runner made, in order. */
const triggered: TriggerCall[] = [];

vi.mock('../../../session/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../session/index.js')>()),
  dispatchMessage: (opts: never) => {
    triggered.push(opts);
    return Promise.resolve(turnBehaviour(opts));
  },
}));

const { createSessionRoomTurnRunner } = await import('../../room-turn-runner.js');
const { SessionEventStore, setSessionEventStore } = await import('../../../session/index.js');
const { createTestDb } = await import('@dorkos/test-utils/db');
const { setRoomService } = await import('../../index.js');
const { agentLookupFor, createRoomHarness, scriptedRunner } =
  await import('../../__tests__/room-test-harness.js');
const { tooManyCanvasOpsMessage } = await import('../room-canvas-service.js');

type Harness = ReturnType<typeof createRoomHarness>;

const ANA = '/agents/ana';
const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** A json document — no dedupe key, so a double write shows up as a second row. */
const jsonCommand = (label: string) => ({
  action: 'open_canvas' as const,
  content: { type: 'json' as const, data: { label }, title: label },
});

describe('a room turn’s canvas commands', () => {
  let harness: Harness;
  let room: RoomWithRoster;
  let ana: string;

  beforeEach(() => {
    runtimesConfig = USER_CONFIG_DEFAULTS.runtimes;
    triggered.length = 0;
    setSessionEventStore(new SessionEventStore(createTestDb()));
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    setRoomService(harness.service);
    room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
      harness.human
    );
    ana = harness.authors.resolveAgent(ANA, 'Ana').id;
  });

  /**
   * A trigger for the real room this harness holds.
   *
   * @param files - What the dispatcher measured about this agent's working
   *   copy for this turn, when it measured anything.
   */
  function turnRequest(files?: {
    worktreePath: string;
    branch: string;
    repoPath: string;
    ahead: number | null;
    behind: number | null;
  }): RoomTurnRequest {
    const entry: RoomEntry = {
      roomId: room.id,
      seq: 1,
      id: 'entry-1',
      authorId: harness.human,
      kind: 'post',
      body: { text: 'show me the plan' },
      mentions: [],
      sessionId: null,
      cascadeRoot: 'entry-1',
      cascadeDepth: 0,
      parentEntryId: null,
      threadRootEntryId: null,
      signature: null,
      createdAt: room.createdAt,
    };
    return {
      room,
      authorId: ana,
      externalAuthor: false,
      agentPath: ANA,
      cwd: ANA,
      sessionId: null,
      entry,
      prompt: entry.body.text,
      roomContext: {
        room: { id: room.id, kind: 'channel', name: '#backend', bridged: false },
        thread: null,
        members: [],
        working: [],
        pending: [],
        pendingTruncated: false,
        ownRecent: [],
        acknowledgments: [],
        triggerEntryId: entry.id,
        triggerAttachments: [],
        addressing: {
          responseMode: 'always',
          engagedUntil: null,
          engagedPostsLeft: null,
          addressedNow: true,
        },
        budget: {
          automaticRepliesLeftInThisRoomThisHour: 9,
          automaticRepliesLeftInTotalThisHour: 99,
          repliesLeftInThisChain: 3,
        },
        ...(files ? { files } : {}),
      },
      attachmentProjection: [],
      onWaiting: () => undefined,
      onActivity: () => undefined,
      onReplyMode: () => undefined,
      onSessionBound: () => undefined,
    };
  }

  /** Open the turn the runner is waiting for, as the real dispatcher does. */
  function openTurn(opts: TriggerCall): void {
    const start = opts.projector.ingest({ type: 'turn_start' });
    opts.onTurnStart?.(start.seq);
  }

  /** The room's log, oldest first. */
  const log = () => harness.service.listEntries(room.id, harness.human, { limit: 100 });

  it('carries the room, the member and one turn id into the runtime', async () => {
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());

    // Routing metadata, and every field of it server-derived. Without this a
    // `control_ui` the turn takes has no way to know which room it is in.
    expect(triggered[0].roomTurn).toMatchObject({ roomId: room.id, authorId: ana });
    expect(typeof triggered[0].roomTurn?.turnId).toBe('string');
  });

  it('applies an UNSTAMPED command — the codex and test-mode path', async () => {
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'ui_command', command: jsonCommand('the plan') });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());

    const documents = harness.service.canvas.list(room.id);
    expect(documents).toHaveLength(1);
    expect(documents[0].title).toBe('the plan');
    expect(documents[0].authorId).toBe(ana);
  });

  it('applies a STAMPED command exactly once — the handler already did', async () => {
    // The dedupe, and the whole reason the stamp exists. `json` has no source
    // key, so a tap that ignored the stamp would leave TWO rows here rather than
    // one refreshed one — which is what makes this able to fail.
    const applied = harness.service.canvas.apply({
      roomId: room.id,
      authorId: ana,
      turnId: 'handler-turn',
      command: jsonCommand('the plan'),
    });
    expect(applied.applied).toBe(true);

    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({
        type: 'ui_command',
        command: jsonCommand('the plan'),
        applied: applied.applied ? { documentId: applied.documentId, rev: applied.rev } : undefined,
      });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());

    expect(harness.service.canvas.list(room.id)).toHaveLength(1);
  });

  it('writes exactly one line in the room’s log, naming every operation', async () => {
    const before = log().length;
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'ui_command', command: jsonCommand('the plan') });
      opts.projector.ingest({
        type: 'ui_command',
        command: { action: 'browser_navigate', url: 'http://localhost:5173/' },
      });
      opts.projector.ingest({ type: 'text_delta', text: 'Put it on the canvas.' });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());

    const entries = log();
    const canvasLines = entries.filter((entry) => entry.body.canvas !== undefined);
    expect(canvasLines).toHaveLength(1);
    expect(canvasLines[0].body.canvas?.ops).toHaveLength(2);
    expect(canvasLines[0].body.subjectAuthorId).toBe(ana);
    // It wakes nobody: written by the system author, addressing no one.
    expect(canvasLines[0].authorId).toBe(harness.authors.system().id);
    expect(canvasLines[0].mentions).toEqual([]);
    expect(entries.length).toBeGreaterThan(before);
  });

  describe('a room that has files of its own', () => {
    beforeEach(() => {
      // Rebuilt with a repo, because that is what makes a file document record
      // WHICH tree it came from. The shared harness above is a room with no
      // files of its own — the ordinary case, and the one every other case here
      // is about.
      harness = createRoomHarness({
        agents,
        runner: scriptedRunner(() => null),
        roomRepoPath: () => '/rooms/backend/repo',
      });
      setRoomService(harness.service);
      room = harness.service.createRoom(
        { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
        harness.human
      );
      ana = harness.authors.resolveAgent(ANA, 'Ana').id;
    });

    it('records how far ahead of the room the turn’s copy was', async () => {
      // **The tap's own carry, not the handler's.** A claude-code turn goes
      // through `control_ui`, which has always passed this; every OTHER runtime —
      // codex, opencode, the scripted one — reaches the table through this tap,
      // and without the carry each of their documents records "not measured".
      // The review surface (spec `canvas-agent-seat` §8) appears only for a copy
      // that is measurably ahead, so the whole of it was unreachable from three
      // of the four runtimes.
      turnBehaviour = (opts) => {
        openTurn(opts);
        opts.projector.ingest({
          type: 'ui_command',
          command: { action: 'open_diff', sourcePath: 'app.txt' },
        });
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };
      await createSessionRoomTurnRunner().run(
        turnRequest({
          worktreePath: ANA,
          branch: 'room/ana',
          repoPath: '/rooms/backend/repo',
          ahead: 3,
          behind: 0,
        })
      );

      const [document] = harness.service.canvas.list(room.id);
      expect(document?.treeKind).toBe('worktree');
      expect(document?.aheadOfMain).toBe(3);
    });

    it('records “not measured” when the dispatcher measured nothing', async () => {
      turnBehaviour = (opts) => {
        openTurn(opts);
        opts.projector.ingest({
          type: 'ui_command',
          command: { action: 'open_diff', sourcePath: 'app.txt' },
        });
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };
      await createSessionRoomTurnRunner().run(turnRequest());

      const [document] = harness.service.canvas.list(room.id);
      // `null`, never `0`: nobody asked, which is a different claim from "level
      // with the room" and must not be shown as one.
      expect(document?.aheadOfMain).toBeNull();
    });
  });

  describe('the face the turn leaves behind', () => {
    /** Start listening to the room's stream; answer with its presence frames. */
    function watchPresence() {
      const abort = new AbortController();
      const seen: RoomEvent[] = [];
      const reading = (async () => {
        for await (const event of harness.service.stream.subscribe(room.id, abort.signal)) {
          seen.push(event);
        }
      })();
      return async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        abort.abort();
        await reading;
        return seen.filter((e) => e.type === 'signal' && e.signal === 'presence');
      };
    }

    it('takes it off at the end, whatever the turn did', async () => {
      // The agent looked at something mid-turn, as `read_canvas` records it.
      const document = harness.service.canvas.open(room.id, ana, {
        type: 'json',
        data: {},
        title: 'the plan',
      });
      harness.service.canvas.noteAgentRead(room.id, ana, document.id);

      const frames = watchPresence();
      turnBehaviour = (opts) => {
        openTurn(opts);
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };
      await createSessionRoomTurnRunner().run(turnRequest());

      const released = await frames();
      expect(released).toMatchObject([{ authorId: ana }]);
      expect(released[0]).not.toHaveProperty('documentId');
    });

    it('takes it off even when posting the turn’s line throws', async () => {
      // **Why the two are in separate `try` blocks.** Posting can fail — a room
      // archived mid-turn, a busy database — and a shared `try` would mean the
      // very endings that go wrong are the ones that leave an agent's face on a
      // tab for a turn that has stopped.
      const document = harness.service.canvas.open(room.id, ana, {
        type: 'json',
        data: {},
        title: 'the plan',
      });
      harness.service.canvas.noteAgentRead(room.id, ana, document.id);
      vi.spyOn(harness.service.canvas, 'finishTurn').mockImplementation(() => {
        throw new Error('the database is locked');
      });

      const frames = watchPresence();
      turnBehaviour = (opts) => {
        openTurn(opts);
        opts.projector.ingest({ type: 'ui_command', command: jsonCommand('the plan') });
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };
      // And the failure stays inside: `collectReply`'s `closed` promise is
      // documented as never rejecting.
      await expect(createSessionRoomTurnRunner().run(turnRequest())).resolves.toBeDefined();

      const released = await frames();
      expect(released).toMatchObject([{ authorId: ana }]);
    });
  });

  it('triggers no turn for anybody', async () => {
    // The property ADR 260911-200302 exists for, read off the dispatcher rather
    // than off a sleep: the canvas line is an entry, and an entry is the one
    // thing that starts a turn in a room — so an entry that started one would
    // show up here as a second dispatch.
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'ui_command', command: jsonCommand('the plan') });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());
    await harness.service.triggersIdle();

    expect(triggered).toHaveLength(1);
  });

  it('records the tree a FILE document was opened against', async () => {
    // Without the turn's cwd on the collector's bounds, every document the tap
    // writes records nothing — and the §8.1 reader rule short-circuits to
    // "anybody may read this", which is the rule inverted rather than relaxed.
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({
        type: 'ui_command',
        command: { action: 'open_file', sourcePath: 'src/router.ts' },
      });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());

    const [document] = harness.service.canvas.list(room.id);
    expect(document.treeKind).toBe('agent-cwd');
    expect(harness.service.canvas.resolvedTreeOf(room.id, document.id)).toBe(ANA);
    // …and a member standing somewhere else is refused its contents, which is
    // the behaviour the recorded tree is FOR.
    expect(harness.service.canvas.mayReadContent(document, '/somewhere/else')).toBe(false);
    expect(harness.service.canvas.mayReadContent(document, ANA)).toBe(true);
  });

  it('names an operation that lands AFTER its turn closed, exactly once', async () => {
    // The ceiling can give up on a turn the agent is still running, and the spec
    // allows that agent to carry on. An operation from it used to open a fresh
    // ledger nothing would ever close: a row on the table with no line in the
    // log naming it, and a map that grew for the life of the process.
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'ui_command', command: jsonCommand('during') });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());
    const turnId = triggered[0].roomTurn?.turnId ?? '';
    expect(turnId).not.toBe('');

    // The straggler: same turn id, long after the collector settled.
    const late = harness.service.canvas.apply({
      roomId: room.id,
      authorId: ana,
      turnId,
      command: jsonCommand('after the ceiling gave up'),
    });
    expect(late.applied).toBe(true);

    const canvasLines = log().filter((entry) => entry.body.canvas !== undefined);
    // Two lines, not one and not three: the turn's own, and the straggler's.
    // Every applied operation is named exactly once.
    expect(canvasLines).toHaveLength(2);
    expect(canvasLines[0].body.canvas?.ops.map((op) => op.title)).toEqual(['during']);
    expect(canvasLines[1].body.canvas?.ops.map((op) => op.title)).toEqual([
      'after the ceiling gave up',
    ]);
    // And it left nothing behind: the ledger it would once have opened is not
    // there, because it was never filed.
    expect(harness.service.canvas.bookkeepingSize().openLedgers).toBe(0);
  });

  it('keeps its memory of FINISHED turns bounded however many turns run', async () => {
    // `finishTurn` remembers a turn so a straggler is recognised and charged,
    // and that memory has to stop growing. Driven past the count bound rather
    // than reasoned about.
    const canvas = harness.service.canvas;
    for (let n = 0; n < 700; n += 1) canvas.finishTurn(`turn-${n}`);
    const { openLedgers, rememberedTurns } = canvas.bookkeepingSize();
    expect(openLedgers).toBe(0);
    expect(rememberedTurns).toBeLessThanOrEqual(500);
  });

  it('keeps its OPEN ledgers bounded however many turns never close', async () => {
    // The other map, and it needs its own case: the two bounds are separate
    // constants precisely so a break in one cannot hide behind the other. A
    // ledger is opened by the first operation of a turn and emptied by
    // `finishTurn`; a turn whose process died never reaches one, so without a
    // count bound this map grows for the life of the server.
    const canvas = harness.service.canvas;
    for (let n = 0; n < 700; n += 1) {
      canvas.apply({
        roomId: room.id,
        authorId: ana,
        turnId: `abandoned-${n}`,
        command: jsonCommand(`doc ${n}`),
      });
    }
    const { openLedgers, rememberedTurns } = canvas.bookkeepingSize();
    expect(openLedgers).toBeLessThanOrEqual(500);
    // …and none of them was closed, so nothing leaked into the other map.
    expect(rememberedTurns).toBe(0);
  });

  it('writes no line at all for a turn that changed nothing', async () => {
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'text_delta', text: 'Nothing to show.' });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());

    expect(log().filter((entry) => entry.body.canvas !== undefined)).toEqual([]);
  });

  it('refuses past the ceiling and names only what it applied', async () => {
    turnBehaviour = (opts) => {
      openTurn(opts);
      for (const n of [1, 2, 3, 4]) {
        opts.projector.ingest({ type: 'ui_command', command: jsonCommand(`doc ${n}`) });
      }
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());

    // Three rows, and a line naming three. An operation nothing applied is
    // claimed nowhere — which is the honest guarantee on this path, where a
    // refusal cannot reach the model.
    expect(harness.service.canvas.list(room.id)).toHaveLength(3);
    const canvasLines = log().filter((entry) => entry.body.canvas !== undefined);
    expect(canvasLines).toHaveLength(1);
    expect(canvasLines[0].body.canvas?.ops).toHaveLength(3);
    // And the sentence a refused operation would have carried is the one the
    // handler path returns, not something this path invents.
    expect(tooManyCanvasOpsMessage(3)).toContain('3 times');
  });

  it('does not hand a finished turn a fresh ceiling', async () => {
    // The ceiling is a per-TURN budget, and ending is not how a turn earns a new
    // one. Counting only the OPEN ledger reads zero for every turn that has
    // closed, so an agent still running past its own line could spend three,
    // three, three, forever — measured, before this stood, as eight more
    // applied operations and nine canvas lines for one turn.
    turnBehaviour = (opts) => {
      openTurn(opts);
      for (const n of [1, 2, 3, 4]) {
        opts.projector.ingest({ type: 'ui_command', command: jsonCommand(`doc ${n}`) });
      }
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await createSessionRoomTurnRunner().run(turnRequest());
    const turnId = triggered[0].roomTurn?.turnId ?? '';
    expect(turnId).not.toBe('');

    const late = harness.service.canvas.apply({
      roomId: room.id,
      authorId: ana,
      turnId,
      command: jsonCommand('one more, after the line went out'),
    });

    // Refused exactly as the in-turn fourth was, with the same sentence.
    expect(late).toMatchObject({ applied: false, code: 'TOO_MANY_CANVAS_OPS_THIS_TURN' });
    // And a refusal writes nothing: no row, and no line announcing one.
    expect(harness.service.canvas.list(room.id)).toHaveLength(3);
    expect(log().filter((entry) => entry.body.canvas !== undefined)).toHaveLength(1);
  });
});
