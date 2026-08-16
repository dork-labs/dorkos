/**
 * The production runner: a room trigger becomes a real session turn.
 *
 * The dispatcher is the only thing stubbed, and only because a real one needs a
 * model. The projector is the REAL projector — which is the point, because the
 * claim this file checks is that a room reads the agent's answer off the same
 * stream a client renders from, gap-free from a cursor taken before the turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomTurnRequest, RoomTurnWaiting } from '../room-trigger.js';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';

const persistSessionRuntime = vi.fn().mockResolvedValue(true);
/** What `session_metadata` holds for the session under test — `null` = no row. */
let storedSettings: Record<string, unknown> | null = null;
/**
 * What the runtime under test declares about itself. `settings` is load-bearing
 * for the seeding tests below: which `runtimes.*` section a room turn inherits
 * its model and effort from is the RUNTIME's declaration, not a list the
 * resolver keeps, so this fixture is what points them at `runtimes.claudeCode`.
 */
const DECLARED_CAPABILITIES = {
  logBackedHistory: false,
  nativeContext: [],
  settings: { configSection: 'claudeCode', supportsEffort: true, sections: [] },
};
const getCapabilities = vi.fn().mockReturnValue(DECLARED_CAPABILITIES);

/**
 * What the runtime calls this session. `undefined` — no alias — is the honest
 * default for Codex, OpenCode and test-mode; Claude Code answers with its own
 * id, which is the whole subject of the canonical-id test below.
 */
let internalSessionId: (sessionId: string) => string | undefined = () => undefined;

/**
 * Which runtimes this server registered. Everything, for most of this file. The
 * execution-defaults tests narrow it, because `registerOptionalRuntime` lets a
 * runtime fail to register — the packaged desktop app bundles only the
 * claude-code SDK — and an agent whose manifest names a missing runtime is
 * resolved onto the default rather than refused.
 */
let registeredRuntimes: string[] = ['claude-code', 'codex', 'opencode', 'test-mode'];

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    persistSessionRuntime: (...args: unknown[]) => persistSessionRuntime(...args),
    getSessionSettings: () => Promise.resolve(storedSettings),
    get: () => ({
      getCapabilities: () => getCapabilities(),
      acquireLock: () => true,
      releaseLock: () => undefined,
      sendMessage: () => undefined,
      interruptQuery: () => Promise.resolve(false),
      getInternalSessionId: (sessionId: string) => internalSessionId(sessionId),
    }),
    has: (type: string) => registeredRuntimes.includes(type),
    getDefaultType: () => 'claude-code',
  },
}));

/**
 * The addressed agent's manifest. Null for most of this file — the room does not
 * need one — but the execution-defaults tests set it, because the agent's own
 * model and effort are read from exactly here.
 */
let agentManifest: Record<string, unknown> | null = null;

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: () => Promise.resolve(agentManifest),
}));

/**
 * The stored `runtimes` section the real `resolveSessionDefaults` reads. The
 * resolver runs for real here — a room turn inheriting the server's default model
 * is the claim, and a stubbed resolver would prove nothing about it.
 */
let runtimesConfig: UserConfig['runtimes'] = USER_CONFIG_DEFAULTS.runtimes;

vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'runtimes' ? runtimesConfig : undefined) },
}));

/** The projector the stub is handed, as this file drives it. */
interface TestProjector {
  ingest: (event: Record<string, unknown>) => { seq: number };
}

/** Everything the runner hands the dispatcher, as this file inspects it. */
interface TriggerCall {
  sessionId: string;
  projector: TestProjector;
  content: string;
  roomContext?: RoomContextData;
  /** The execution settings the runner resolved for this turn (model, effort). */
  settings?: Record<string, unknown>;
  /** The runtime the real dispatcher resolves the canonical id through. */
  runtime: { getInternalSessionId: (sessionId: string) => string | undefined };
  /**
   * How the real dispatcher tells the room which `turn_start` is its own.
   *
   * Every stub here has to call it, exactly as the real one does, because the
   * collector now matches on that identity rather than on the trigger text. A
   * stub that opened a turn without it would be modelling somebody ELSE's turn
   * — which is a thing worth being able to model, and {@link openTurn} is how.
   */
  onTurnStart?: (seq: number) => void;
  /** What the room asked the dispatcher to do with a session already working. */
  whenBusy?: string;
  /**
   * How the real dispatcher reports that an ACCEPTED dispatch settled without
   * ever running — the drop DOR-1242 added. Driving it here is the only way to
   * model a turn that will never start.
   */
  onSettled?: (outcome: 'ok' | 'failed') => void;
}

/** What the stubbed dispatch does with the projector it is handed. */
let turnBehaviour: (opts: TriggerCall) => {
  accepted: boolean;
  canonicalId?: string;
};

/** Every dispatch this file's runner made, in order. */
const triggered: TriggerCall[] = [];

vi.mock('../../session/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/index.js')>()),
  dispatchMessage: (opts: never) => {
    triggered.push(opts);
    return Promise.resolve(turnBehaviour(opts));
  },
}));

const { createSessionRoomTurnRunner } = await import('../room-turn-runner.js');
const { SessionEventStore, setSessionEventStore } = await import('../../session/index.js');
const { setRoomAttachmentStores } = await import('../index.js');
const { LocalRoomAttachmentStore } = await import('../attachments/local-room-attachment-store.js');
const { PROJECTED_ATTACHMENTS_ROOT } = await import('../attachments/attachment-paths.js');
type SessionEventStoreInstance = InstanceType<typeof SessionEventStore>;

let counter = 0;

/** Flush the microtasks a `run` call needs to reach its subscription. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A trigger request for a room nothing else is using.
 *
 * @param overrides - Fields to replace, plus `entryText` for the message body,
 *   which is what makes two requests compose two different prompts.
 */
function request(
  overrides: Partial<RoomTurnRequest> & { entryText?: string } = {}
): RoomTurnRequest {
  counter += 1;
  const { entryText, ...rest } = overrides;
  const room = {
    id: `room-${counter}`,
    kind: 'channel',
    slug: 'backend',
    title: 'Backend',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    wellKnown: null,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    members: [],
    viewerAuthorId: 'human',
    reactionFrequents: ['👍', '❤️', '🎉'],
  } satisfies RoomWithRoster;
  const entry: RoomEntry = {
    roomId: room.id,
    seq: 1,
    id: `entry-${counter}`,
    authorId: 'human',
    kind: 'post',
    body: { text: entryText ?? 'is the build green?' },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${counter}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: room.createdAt,
  };
  return {
    room,
    authorId: 'author-ana',
    agentPath: '/repo/ana',
    sessionId: null,
    entry,
    prompt: entry.body.text,
    roomContext: {
      room: { id: room.id, kind: 'channel', name: '#backend', bridged: false },
      thread: null,
      members: [
        { handle: 'ana', displayName: 'Ana', isPerson: false, isSelf: true, origin: 'local' },
        { handle: 'dorian', displayName: 'You', isPerson: true, isSelf: false, origin: 'local' },
      ],
      working: [],
      pending: [],
      pendingTruncated: false,
      ownRecent: [],
      acknowledgments: [],
      triggerAttachments: [],
      addressing: {
        responseMode: 'always',
        engagedUntil: null,
        engagedPostsLeft: null,
        addressedNow: false,
      },
      budget: {
        automaticRepliesLeftInThisRoomThisHour: 9,
        automaticRepliesLeftInTotalThisHour: 99,
        repliesLeftInThisChain: 3,
      },
    },
    // Nothing to project by default; the projection test supplies its own.
    attachmentProjection: [],
    // A no-op by default: most of this file is about what a turn PRODUCES, and
    // only the two tests that are about a turn stopping supply their own.
    onWaiting: () => undefined,
    ...rest,
  };
}

/**
 * Open the turn the runner is waiting for, telling it which turn is its own.
 *
 * The real dispatcher reports the `turn_start`'s seq the instant it stamps
 * it; a stub that skips this is opening a turn the room did not start, which is
 * how `readsSomebodyElsesTurn` below models the case that used to be
 * indistinguishable.
 *
 * @param opts - The trigger call the stub is answering.
 * @param userMessage - The trigger text to carry, when the test cares.
 */
function openTurn(opts: TriggerCall, userMessage?: string): void {
  const start = opts.projector.ingest(
    userMessage === undefined ? { type: 'turn_start' } : { type: 'turn_start', userMessage }
  );
  opts.onTurnStart?.(start.seq);
}

/**
 * A turn that streams `parts` and closes cleanly, resolving its canonical id
 * the way the real dispatcher does — off the runtime, not off the request.
 * Echoing the requested id back unconditionally is what let a whole class of
 * id-drift bug hide in this suite.
 */
function saysAndCloses(...parts: string[]): typeof turnBehaviour {
  return (opts) => {
    const { sessionId, projector, runtime } = opts;
    openTurn(opts);
    for (const text of parts) projector.ingest({ type: 'text_delta', text });
    projector.ingest({ type: 'turn_end' });
    return { accepted: true, canonicalId: runtime.getInternalSessionId(sessionId) ?? sessionId };
  };
}

describe('createSessionRoomTurnRunner', () => {
  beforeEach(() => {
    persistSessionRuntime.mockClear();
    internalSessionId = () => undefined;
    turnBehaviour = saysAndCloses('green');
  });

  it('has the files on disk BEFORE the turn is triggered', async () => {
    // Ordering, not just the end state: the context handed to the model names
    // these paths, so a projection that landed after the dispatch would be a
    // window in which the agent could read a path that was not yet there
    // (ADR 260807-233816).
    const dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-runner-home-'));
    const agentPath = await mkdtemp(path.join(tmpdir(), 'dorkos-runner-agent-'));
    try {
      const store = new LocalRoomAttachmentStore(dorkHome);
      setRoomAttachmentStores({ attachments: store, rows: {} as never });

      // Built first, so the file is staged under the room id this very request
      // carries — the runner scopes its store reads by it.
      const turnRequest = request({
        agentPath,
        attachmentProjection: [
          {
            entryId: 'entry-x',
            attachmentId: 'att1',
            extension: 'log',
            name: 'crash.log',
            relativePath: `${PROJECTED_ATTACHMENTS_ROOT}/entry-x/att1-crash.log`,
          },
        ],
      });
      await store.put(turnRequest.room.id, 'att1', 'log', Buffer.from('crash!'));

      const projected = path.join(
        agentPath,
        PROJECTED_ATTACHMENTS_ROOT,
        'entry-x',
        'att1-crash.log'
      );
      let existedWhenTriggered: boolean | null = null;
      turnBehaviour = (opts) => {
        existedWhenTriggered = existsSync(projected);
        openTurn(opts);
        opts.projector.ingest({ type: 'text_delta', text: 'got it' });
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };

      const result = await createSessionRoomTurnRunner().run(turnRequest);

      expect(result.text).toBe('got it');
      // The assertion that matters: the file was already there when the turn
      // opened, not merely there by the time the turn finished.
      expect(existedWhenTriggered).toBe(true);
      expect(await readFile(projected)).toEqual(Buffer.from('crash!'));
    } finally {
      await rm(dorkHome, { recursive: true, force: true });
      await rm(agentPath, { recursive: true, force: true });
    }
  });

  it('returns what the agent said, read off the session stream', async () => {
    turnBehaviour = saysAndCloses('Green', ' — ', 'nothing failed.');
    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBe('Green — nothing failed.');
  });

  it('keeps two assistant messages apart instead of welding them together', async () => {
    // The observed post: `…before answering.Congrats on…` — a note the agent
    // wrote before reaching for a tool, glued with no space to the answer it
    // wrote afterwards. Every `text_delta` in the turn went into one buffer, and
    // a buffer cannot know that a tool call happened in the middle of it.
    //
    // Those are two assistant messages: a model emits its text and its
    // `tool_use` together, and everything after the result is a new message. The
    // durable stream carries no message boundary to read, so the tool events are
    // the boundary — and they are exact for this shape, which is the one that
    // produces run-on text.
    //
    // Nothing is dropped. Posting only the last block was considered and is not
    // approved: a preamble is something the agent chose to say.
    turnBehaviour = (opts) => {
      const { sessionId, projector } = opts;
      openTurn(opts);
      projector.ingest({ type: 'text_delta', text: 'Let me read the release notes first.' });
      projector.ingest({
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'Read',
        status: 'running',
      });
      projector.ingest({
        type: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'Read',
        status: 'success',
        result: 'v2.1 shipped',
      });
      projector.ingest({ type: 'text_delta', text: 'Congrats on shipping v2.1!' });
      projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: sessionId };
    };

    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBe('Let me read the release notes first.\n\nCongrats on shipping v2.1!');
  });

  it('does not split one message on the token counts that stream through it', async () => {
    // The counter-assertion, and the reason the boundary is the tool events
    // rather than "anything that is not text". A `status_change` really does
    // land at the end of every assistant message — the SDK's `message_delta`
    // carries the output-token count — but it also lands mid-message, so
    // breaking on it would cut single sentences at unpredictable points.
    turnBehaviour = (opts) => {
      const { sessionId, projector } = opts;
      openTurn(opts);
      projector.ingest({ type: 'text_delta', text: 'The build is ' });
      projector.ingest({ type: 'status_change', status: { outputTokens: 12 } });
      projector.ingest({ type: 'text_delta', text: 'green.' });
      projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: sessionId };
    };

    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBe('The build is green.');
  });

  it('mints a session on the first answer and reuses the bound one after', async () => {
    const runner = createSessionRoomTurnRunner();

    const first = await runner.run(request());
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const second = await runner.run(request({ sessionId: 'session-already-bound' }));
    expect(second.sessionId).toBe('session-already-bound');
    // The runtime binding is written on every turn; the registry only binds a
    // session that has no runtime yet, so the first write wins and a second one
    // changes nothing.
    expect(persistSessionRuntime).toHaveBeenLastCalledWith(
      'session-already-bound',
      'claude-code',
      '/repo/ana'
    );
  });

  it('answers on, and records ownership under, the id the runtime assigned', async () => {
    // Claude Code names the session itself on the first turn and files the
    // transcript under THAT id. The room asked with a placeholder; everything
    // durable must land on the runtime's id, and — the part that was broken —
    // the id the runner hands back is the id the room binds, so `session_metadata`
    // and `room_sessions` cannot disagree about which session this is.
    const canonical = 'sdk-canonical-9f3c';
    internalSessionId = () => canonical;

    const result = await createSessionRoomTurnRunner().run(
      request({ sessionId: 'room-placeholder' })
    );

    expect(result.sessionId).toBe(canonical);
    expect(persistSessionRuntime).toHaveBeenCalledWith(canonical, 'claude-code', '/repo/ana');
    expect(persistSessionRuntime).not.toHaveBeenCalledWith(
      'room-placeholder',
      expect.anything(),
      expect.anything()
    );
    // The agreement itself, asserted rather than assumed: one id answers both
    // questions, so a room session never falls through to the registry's legacy
    // "it must be claude-code" inference for want of a row.
    expect(persistSessionRuntime.mock.calls[0][0]).toBe(result.sessionId);
  });

  it('still delivers the answer when recording who owns the session fails', async () => {
    // NOTHING AFTER THE MODEL HAS SPOKEN MAY THROW OUT OF `run`, and this is the
    // line that used to. `persistSessionRuntime` was awaited above the busy
    // guard, so a `SQLITE_BUSY` on one bookkeeping row — a live hazard, which is
    // why `bindRoomSession` in `room-trigger.ts` is already try-wrapped for it —
    // escaped a turn that had opened, streamed and ended.
    //
    // Two things broke, and the second is the quiet one. The room reported an
    // ANSWERED turn as failed and dropped what the agent said. And because the
    // dispatcher reads a throw out of `run` as "the turn never started", it
    // rewound the read cursor and replayed the entire ambient window to the next
    // turn (room-participation spec §8.3) — a duplicate conversation caused by a
    // row that has nothing to do with either.
    persistSessionRuntime.mockRejectedValueOnce(
      Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    );
    turnBehaviour = saysAndCloses('Green — nothing failed.');

    const result = await createSessionRoomTurnRunner().run(request());

    // It was really attempted, so the assertions below are about a write that
    // failed rather than one that never ran.
    expect(persistSessionRuntime).toHaveBeenCalledTimes(1);
    // (a) `run` resolves — the dispatcher's "a throw means nothing ran" holds.
    // (b) and the answer is intact, which is what the room posts.
    expect(result.text).toBe('Green — nothing failed.');
    // (c) The read cursor therefore stays advanced. These two assertions ARE
    // that claim: `rewindClaimCursor` has exactly two triggers — `run` throwing,
    // and `unanswered === 'busy'` — and this result is neither. The dispatcher
    // half is pinned in `ambient-pending.test.ts`.
    expect(result.unanswered).toBeUndefined();
  });

  it('says nothing rather than queueing behind an operator who is mid-turn', async () => {
    turnBehaviour = () => ({ accepted: false });
    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBeNull();
    // Named, not merely empty: a `null` on its own is what an agent with
    // nothing to say returns, and the room stayed silent about both (DOR-621).
    expect(result.unanswered).toBe('busy');
  });

  it('asks to be refused only by a STRANGER, never by its own previous turn', async () => {
    // The room already allows one turn per `(room, agent)` and holds a
    // re-mention until that turn's claim releases (RP8), so the only turn it can
    // ever race is somebody else's. Asking for a blanket refusal instead lost
    // the beat between the previous turn ending and its slot being handed back,
    // and the room apologised for a message it was about to answer (DOR-1230).
    triggered.length = 0;
    await createSessionRoomTurnRunner().run(request());
    expect(triggered[0]?.whenBusy).toBe('refuse-foreign');
  });

  it('stops waiting the moment an accepted trigger is reported as never having run', async () => {
    // DOR-1242. A `refuse-foreign` trigger that waited out its own tail and then
    // lost the session to a stranger is DROPPED once its original wait is spent,
    // and `onSettled('failed')` is the dispatcher saying so. Without reading it
    // the room waits on a turn nothing will ever start: a late notice at `waitMs`
    // and "something went wrong" at the ceiling, long after the message — which
    // is worse than what it replaced, so the report has to be acted on.
    //
    // The BOUNDS are the assertion. They are set far above the drop, so a run
    // that resolves quickly can only have resolved because it was told; one that
    // waited them out is the regression.
    turnBehaviour = (opts) => {
      // Accepted, and no turn ever opens — nothing calls `onTurnStart`.
      setTimeout(() => opts.onSettled?.('failed'), 0);
      return { accepted: true, canonicalId: opts.sessionId };
    };

    const startedAt = Date.now();
    const result = await createSessionRoomTurnRunner({
      waitMs: () => 5_000,
      ceilingMs: () => 10_000,
    }).run(request());

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // The room's ordinary could-not-answer path, not a late answer that nothing
    // will ever resolve.
    expect(result.text).toBeNull();
    expect(result.unanswered).toBe('failed');
    expect(result.late).toBeUndefined();
  });

  it('keeps waiting on a turn that DID start and then failed, which has its own reporting', async () => {
    // The other side of the guard above: `onSettled('failed')` also fires for a
    // turn that really ran and then errored. That one has a `turn_start`, is
    // being watched by the collector, and must keep its existing path — cutting
    // it short here would drop an answer the agent had already produced.
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'text_delta', text: 'Half an answer.' });
      setTimeout(() => {
        opts.projector.ingest({ type: 'turn_end' });
        opts.onSettled?.('failed');
      }, 0);
      return { accepted: true, canonicalId: opts.sessionId };
    };

    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBe('Half an answer.');
  });

  it('reads a turn whose start arrives after the dispatch has already resolved', async () => {
    // The shape a queued launch has: `dispatchMessage` answers at acceptance, and
    // the `turn_start` follows macrotasks later when the session frees up. The
    // collector anchors on the turn's identity rather than on the dispatch
    // returning, so this is read exactly like a turn that opened at once.
    //
    // **It does not exercise `whenBusy`** — this file stubs the dispatcher, so
    // which busy mode the room asks for is pinned by the case above and by
    // `message-dispatcher.test.ts`. What is pinned here is only the timing.
    turnBehaviour = (opts) => {
      setTimeout(() => {
        openTurn(opts);
        opts.projector.ingest({ type: 'text_delta', text: 'Paris.' });
        opts.projector.ingest({ type: 'turn_end' });
      }, 0);
      return { accepted: true, canonicalId: opts.sessionId };
    };
    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBe('Paris.');
    expect(result.unanswered).toBeUndefined();
  });

  it('reports a turn that ended in an error, rather than an empty answer', async () => {
    turnBehaviour = (opts) => {
      const { sessionId, projector } = opts;
      openTurn(opts);
      projector.ingest({ type: 'turn_end', terminalReason: 'error' });
      return { accepted: true, canonicalId: sessionId };
    };
    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBeNull();
    expect(result.unanswered).toBe('failed');
  });

  it('does not mistake a quiet turn for a failed one', async () => {
    turnBehaviour = saysAndCloses('   ');
    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBeNull();
    expect(result.unanswered).toBeUndefined();
  });

  it('hands back an answer that outran the wait instead of dropping it', async () => {
    // The turn is still open when the runner returns, so `run` cannot resolve
    // before the deadline and the assertion below cannot race it.
    //
    // Fake timers, deliberately (DOR-933): under real timers a 5ms
    // `setTimeout` can fire a hair under 5ms of wall clock, and
    // `Date.now()` — millisecond-quantized — rounds that down to 4,
    // flaking the exact-value assertion below. Fake timers make `Date.now()`
    // advance in lockstep with the timer queue, so `waitedMs` is exactly the
    // configured wait.
    vi.useFakeTimers();
    try {
      let finishTurn = (): void => undefined;
      turnBehaviour = (opts) => {
        const { sessionId, projector } = opts;
        openTurn(opts);
        finishTurn = () => {
          projector.ingest({ type: 'text_delta', text: 'green' });
          projector.ingest({ type: 'turn_end' });
        };
        return { accepted: true, canonicalId: sessionId };
      };

      const running = createSessionRoomTurnRunner({ waitMs: () => 5 }).run(request());
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(4);
      const result = await running;
      expect(result.text).toBeNull();
      expect(result.unanswered).toBeUndefined();
      expect(result.late).toBeDefined();

      finishTurn();
      const late = await result.late;
      expect(late?.text).toBe('green');
      expect(late?.unanswered).toBeUndefined();
      expect(late?.waitedMs).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never posts the half of an answer it had when the wait ran out', async () => {
    // The old timeout aborted the read, so whatever had streamed by then was
    // returned as if it were the whole answer.
    let finishTurn = (): void => undefined;
    turnBehaviour = (opts) => {
      const { sessionId, projector } = opts;
      openTurn(opts);
      projector.ingest({ type: 'text_delta', text: 'the build is ' });
      finishTurn = () => {
        projector.ingest({ type: 'text_delta', text: 'green' });
        projector.ingest({ type: 'turn_end' });
      };
      return { accepted: true, canonicalId: sessionId };
    };

    const result = await createSessionRoomTurnRunner({ waitMs: () => 5 }).run(request());
    expect(result.text).toBeNull();

    finishTurn();
    expect((await result.late)?.text).toBe('the build is green');
  });

  it('reads its own turn, never the tail of the one already running', async () => {
    // The session write-lock lets the same room re-acquire, so a follow-up
    // message starts a second turn while the first is still streaming. Its
    // cursor sits INSIDE turn one, and anchoring on the cursor alone made it
    // break at turn one's `turn_end` and post the tail it had caught —
    // mid-sentence, and a duplicate of what turn one was already posting.
    let stream: TestProjector | undefined;
    const calls: TriggerCall[] = [];
    turnBehaviour = (opts) => {
      stream = opts.projector;
      calls.push(opts);
      return { accepted: true, canonicalId: opts.sessionId };
    };
    const runner = createSessionRoomTurnRunner();
    const shared = 'session-two-messages';

    const first = runner.run(request({ sessionId: shared }));
    await settle();
    openTurn(calls[0], calls[0].content);
    stream?.ingest({ type: 'text_delta', text: 'the build is ' });

    // The follow-up lands mid-turn. Its cursor is now inside turn one.
    const second = runner.run(request({ sessionId: shared, entryText: 'and the tests?' }));
    await settle();

    stream?.ingest({ type: 'text_delta', text: 'green and here is why' });
    stream?.ingest({ type: 'turn_end' });
    expect((await first).text).toBe('the build is green and here is why');

    openTurn(calls[1], calls[1].content);
    stream?.ingest({ type: 'text_delta', text: 'the tests pass' });
    stream?.ingest({ type: 'turn_end' });
    expect((await second).text).toBe('the tests pass');
  });

  it('ignores a turn it did not start, even one carrying the same words', async () => {
    // Two holes, one shape. The collector used to decide "is this turn mine?"
    // by comparing the trigger text on the `turn_start` — so a turn triggered
    // with the SAME message satisfied it, and a turn carrying NO message at all
    // (a `/compact`-style command intent, whose `turn_start` has no
    // `userMessage`) satisfied it by default. Either one made the next thing
    // that session said the room's answer to a question it never asked.
    //
    // Identity replaces resemblance: the room learns its own turn's seq from
    // the trigger that stamped it, and a `turn_start` that is not that seq is
    // somebody else's whatever it says.
    let stream: TestProjector | undefined;
    let ownCall: TriggerCall | undefined;
    turnBehaviour = (opts) => {
      stream = opts.projector;
      ownCall = opts;
      return { accepted: true, canonicalId: opts.sessionId };
    };

    const answered = createSessionRoomTurnRunner({ waitMs: () => 50 }).run(
      request({ entryText: 'is the build green?' })
    );
    await settle();

    // A foreign turn, opened on the same session with the identical prompt, and
    // then one with no prompt at all. Neither is the room's.
    stream?.ingest({ type: 'turn_start', userMessage: 'is the build green?' });
    stream?.ingest({ type: 'text_delta', text: 'not the answer to the room' });
    stream?.ingest({ type: 'turn_end' });
    stream?.ingest({ type: 'turn_start' });
    stream?.ingest({ type: 'text_delta', text: 'compacted the transcript' });
    stream?.ingest({ type: 'turn_end' });

    // The room's own turn, last, and the only one it reads.
    openTurn(ownCall as TriggerCall, ownCall?.content);
    stream?.ingest({ type: 'text_delta', text: 'green' });
    stream?.ingest({ type: 'turn_end' });

    expect((await answered).text).toBe('green');
  });

  describe('the grace before it says so', () => {
    /** A turn that opens and then waits for the test to feed it. */
    function openAndHold(): { call: () => TriggerCall; waited: RoomTurnWaiting[] } {
      const waited: RoomTurnWaiting[] = [];
      let opened: TriggerCall | undefined;
      turnBehaviour = (opts) => {
        opened = opts;
        openTurn(opts);
        return { accepted: true, canonicalId: opts.sessionId };
      };
      return {
        call: () => {
          if (!opened) throw new Error('the turn never started');
          return opened;
        },
        waited,
      };
    }

    /** An `approval_required` for `id`, as the adapter pushes one. */
    function approvalRequired(id: string): Record<string, unknown> {
      return {
        type: 'approval_required',
        id,
        startedAt: Date.now(),
        toolCallId: id,
        toolName: 'Bash',
        input: '{}',
      };
    }

    it('says nothing at all about an approval somebody answers straight away', async () => {
      // **The over-participation guard.** Nearly every gated tool call is
      // answered in seconds by whoever is already watching that agent, and a
      // durable line above every one of them would put a permanent "Ana is
      // waiting for you to approve something" in the room for a state that
      // lasted three seconds — once per gated turn, in every room, forever.
      vi.useFakeTimers();
      try {
        const turn = openAndHold();
        const answered = createSessionRoomTurnRunner({
          waitMs: () => 10 * 60_000,
          waitingGraceMs: () => 60_000,
        }).run(request({ onWaiting: (waiting) => turn.waited.push(waiting) }));
        await vi.advanceTimersByTimeAsync(1);

        turn.call().projector.ingest(approvalRequired('call-1'));
        await vi.advanceTimersByTimeAsync(3_000);
        turn.call().projector.ingest({
          type: 'interaction_resolved',
          id: 'call-1',
          resolution: 'approved',
        });
        await vi.advanceTimersByTimeAsync(120_000);

        expect(turn.waited).toEqual([]);

        turn.call().projector.ingest({ type: 'text_delta', text: 'green' });
        turn.call().projector.ingest({ type: 'turn_end' });
        await vi.advanceTimersByTimeAsync(1);
        expect((await answered).text).toBe('green');
      } finally {
        vi.useRealTimers();
      }
    });

    it('says so once when the prompt is still standing a minute later', async () => {
      vi.useFakeTimers();
      try {
        const turn = openAndHold();
        const answered = createSessionRoomTurnRunner({
          waitMs: () => 10 * 60_000,
          waitingGraceMs: () => 60_000,
        }).run(request({ onWaiting: (waiting) => turn.waited.push(waiting) }));
        await vi.advanceTimersByTimeAsync(1);

        turn.call().projector.ingest(approvalRequired('call-1'));
        await vi.advanceTimersByTimeAsync(59_000);
        // Still nothing: the grace has not run out.
        expect(turn.waited).toEqual([]);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(turn.waited).toEqual([{ kind: 'approval', toolName: 'Bash' }]);

        turn.call().projector.ingest({ type: 'turn_end' });
        await vi.advanceTimersByTimeAsync(1);
        await answered;
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports the wait first and the failure after, when a stall kills the turn', async () => {
      // Order matters to the reader: "it is waiting on you" and then "it fell
      // over" is a story; the other way round is a contradiction.
      vi.useFakeTimers();
      try {
        const turn = openAndHold();
        const answered = createSessionRoomTurnRunner({
          waitMs: () => 10 * 60_000,
          waitingGraceMs: () => 60_000,
        }).run(request({ onWaiting: (waiting) => turn.waited.push(waiting) }));
        await vi.advanceTimersByTimeAsync(1);

        turn.call().projector.ingest(approvalRequired('call-1'));
        await vi.advanceTimersByTimeAsync(60_500);
        expect(turn.waited).toHaveLength(1);

        // The stall watchdog's terminal sequence, a second later.
        await vi.advanceTimersByTimeAsync(1_000);
        turn.call().projector.ingest({ type: 'turn_end', terminalReason: 'error' });
        await vi.advanceTimersByTimeAsync(1);

        const result = await answered;
        expect(result.unanswered).toBe('failed');
        // And nothing more is said afterwards: the turn is over, so the prompt
        // it was stopped on can no longer be answered by anybody.
        await vi.advanceTimersByTimeAsync(120_000);
        expect(turn.waited).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('forgets a standing prompt when the turn ends without resolving it', async () => {
      // A timer that outlived its turn would tell a room to go and answer a
      // prompt that no longer exists.
      vi.useFakeTimers();
      try {
        const turn = openAndHold();
        const answered = createSessionRoomTurnRunner({
          waitMs: () => 10 * 60_000,
          waitingGraceMs: () => 60_000,
        }).run(request({ onWaiting: (waiting) => turn.waited.push(waiting) }));
        await vi.advanceTimersByTimeAsync(1);

        turn.call().projector.ingest(approvalRequired('call-1'));
        await vi.advanceTimersByTimeAsync(1_000);
        turn.call().projector.ingest({ type: 'turn_end' });
        await vi.advanceTimersByTimeAsync(1);
        await answered;

        await vi.advanceTimersByTimeAsync(120_000);
        expect(turn.waited).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('says nothing about a prompt raised inside somebody else s turn', async () => {
    // The counter-assertion, and the reason it is not enough to watch the
    // session for approval cards: a prompt belonging to a turn the room did not
    // start is not the room's news, and reporting it would put a line in a
    // shared conversation about work nobody there asked for.
    const waited: RoomTurnWaiting[] = [];
    let stream: TestProjector | undefined;
    let ownCall: TriggerCall | undefined;
    turnBehaviour = (opts) => {
      stream = opts.projector;
      ownCall = opts;
      return { accepted: true, canonicalId: opts.sessionId };
    };

    // No grace, so this test can only stay green because the prompt belongs to
    // somebody else's turn — never because the room simply had not spoken yet.
    const answered = createSessionRoomTurnRunner({
      waitMs: () => 50,
      waitingGraceMs: () => 0,
    }).run(request({ onWaiting: (waiting) => waited.push(waiting) }));
    await settle();

    stream?.ingest({ type: 'turn_start' });
    stream?.ingest({
      type: 'approval_required',
      id: 'call-elsewhere',
      startedAt: Date.now(),
      toolCallId: 'call-elsewhere',
      toolName: 'Bash',
      input: '{}',
    });
    stream?.ingest({ type: 'turn_end' });

    openTurn(ownCall as TriggerCall);
    stream?.ingest({ type: 'text_delta', text: 'green' });
    stream?.ingest({ type: 'turn_end' });

    expect((await answered).text).toBe('green');
    // Long enough for a zero-grace timer to have fired several times over.
    await settle();
    expect(waited).toEqual([]);
  });

  it('keeps listening for at least as long as it waits, whatever the pair says', async () => {
    // `rooms.replyWaitMinutes: 120` with `rooms.lateReplyCeilingMinutes: 1` is
    // schema-valid — two independent fields, both in range. Unclamped, the room
    // stops LISTENING an hour and fifty-nine minutes before it stops WAITING,
    // so a healthy turn is reported as failed and its answer is thrown away:
    // this PR's own defect, reintroduced through the settings screen.
    //
    // The pair here is that shape with the clock scaled down: a wait no timer
    // in this test can reach, and a ceiling that has already expired many times
    // over by the time the turn answers.
    let finishTurn = (): void => undefined;
    turnBehaviour = (opts) => {
      const { sessionId, projector, content } = opts;
      openTurn(opts, content);
      finishTurn = () => {
        projector.ingest({ type: 'text_delta', text: 'green' });
        projector.ingest({ type: 'turn_end' });
      };
      return { accepted: true, canonicalId: sessionId };
    };

    const runner = createSessionRoomTurnRunner({ waitMs: () => 60_000, ceilingMs: () => 1 });
    const answered = runner.run(request());
    // Twenty times the unclamped ceiling: if it were in force, it has fired.
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishTurn();

    const result = await answered;
    // The subject is the answer, not the absence of a crash.
    expect(result.text).toBe('green');
    expect(result.unanswered).toBeUndefined();
    expect(result.late).toBeUndefined();
  });

  it('gives up on a turn that never closes, and says the turn failed', async () => {
    turnBehaviour = (opts) => {
      openTurn(opts);
      return { accepted: true, canonicalId: opts.sessionId };
    };

    const result = await createSessionRoomTurnRunner({ waitMs: () => 5, ceilingMs: () => 30 }).run(
      request()
    );
    expect(result.late).toBeDefined();

    const late = await result.late;
    expect(late?.text).toBeNull();
    expect(late?.unanswered).toBe('failed');
  });

  it('writes no runtime binding for a turn that never started', async () => {
    // A ghost `session_metadata` row per failed message: `bindRoomSession` is
    // never reached, so the next trigger mints a fresh id and the dead row and
    // its projector stay forever.
    turnBehaviour = () => ({ accepted: false });
    await createSessionRoomTurnRunner().run(request());
    expect(persistSessionRuntime).not.toHaveBeenCalled();

    turnBehaviour = () => {
      throw new Error('runtime is down');
    };
    await expect(createSessionRoomTurnRunner().run(request())).rejects.toThrow('runtime is down');
    expect(persistSessionRuntime).not.toHaveBeenCalled();
  });

  it('treats an empty turn as nothing to post', async () => {
    turnBehaviour = saysAndCloses('   ');
    expect((await createSessionRoomTurnRunner().run(request())).text).toBeNull();
  });

  it('stops at the turn boundary rather than swallowing the next turn', async () => {
    turnBehaviour = (opts) => {
      const { sessionId, projector } = opts;
      openTurn(opts);
      projector.ingest({ type: 'text_delta', text: 'first' });
      projector.ingest({ type: 'turn_end' });
      // Whatever happens on this session afterwards is not this room's answer.
      projector.ingest({ type: 'text_delta', text: 'second' });
      return { accepted: true, canonicalId: sessionId };
    };
    expect((await createSessionRoomTurnRunner().run(request())).text).toBe('first');
  });
});

describe('what a room turn actually sends (ADR-0273)', () => {
  beforeEach(() => {
    triggered.length = 0;
    turnBehaviour = saysAndCloses('green');
  });

  it('sends the message byte for byte, with nothing wrapped around it', async () => {
    // The regression guard for the prose prompt this replaced. `content` becomes
    // the visible user turn in the session transcript, so anything prepended
    // here is words nobody typed showing up as though a person had typed them.
    const body = 'is the build green?';
    await createSessionRoomTurnRunner().run(request({ entryText: body }));
    expect(triggered).toHaveLength(1);
    expect(triggered[0].content).toBe(body);
  });

  it('puts the room framing in the context bag instead', async () => {
    await createSessionRoomTurnRunner().run(request());
    expect(triggered[0].roomContext?.room.name).toBe('#backend');
    // The field the whole phase exists for: an agent can tell a person from a
    // machine. Assert the subject, not that a roster is merely present.
    expect(triggered[0].roomContext?.members.find((m) => m.handle === 'dorian')?.isPerson).toBe(
      true
    );
    expect(triggered[0].roomContext?.members.find((m) => m.handle === 'ana')?.isPerson).toBe(false);
  });
});

describe('what a room turn runs with (execution defaults)', () => {
  beforeEach(() => {
    triggered.length = 0;
    persistSessionRuntime.mockClear();
    turnBehaviour = saysAndCloses('green');
    storedSettings = null;
    runtimesConfig = USER_CONFIG_DEFAULTS.runtimes;
    agentManifest = null;
    registeredRuntimes = ['claude-code', 'codex', 'opencode', 'test-mode'];
  });

  it("starts a room agent's first turn on the server's default model and effort", async () => {
    // The gap this closes: a room turn had NO model or effort path at all. Its
    // session row is written only after the turn starts, so reading the row —
    // the way every other session inherits — would always come back empty on
    // the turn that matters.
    runtimesConfig = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: {
        ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
        defaultModel: 'opus',
        defaultEffort: 'high',
      },
    };

    await createSessionRoomTurnRunner().run(request());

    expect(triggered[0].settings).toEqual({ model: 'opus', effort: 'high' });
    // The row itself is written by the registry, which resolves the same
    // defaults on the INSERT that creates it — so the SECOND turn inherits them
    // the ordinary way rather than through this path.
    expect(persistSessionRuntime).toHaveBeenLastCalledWith(
      expect.any(String),
      'claude-code',
      '/repo/ana'
    );
  });

  it('leaves a room session that already has settings alone', async () => {
    // "Applies to new conversations — running ones keep their settings." A room
    // conversation with a row is a running one, whatever the default now says.
    runtimesConfig = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
    };
    storedSettings = { model: 'sonnet' };

    await createSessionRoomTurnRunner().run(request({ sessionId: 'room-session-with-a-row' }));

    expect(triggered[0].settings).toEqual({});
  });

  it('sends no model at all when nothing is configured', async () => {
    await createSessionRoomTurnRunner().run(request());
    expect(triggered[0].settings).toEqual({});
  });

  it("runs the turn on the addressed agent's own model and effort", async () => {
    // Rooms are where the per-agent setting earns its keep: the room addressed
    // THIS agent, so what it says about itself outranks the server's default.
    runtimesConfig = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: {
        ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
        defaultModel: 'opus',
        defaultEffort: 'high',
      },
    };
    agentManifest = { runtime: 'claude-code', model: 'sonnet', effort: 'low' };

    await createSessionRoomTurnRunner().run(request());

    expect(triggered[0].settings).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('never seeds a Codex model onto the claude-code session a missing runtime falls back to', async () => {
    // The reported break, end to end. This build has no Codex adapter, so the
    // room turn runs on claude-code — and the agent's `gpt-5.3-codex` would
    // otherwise ride along onto it, handing the Claude Code SDK an id from
    // another provider's namespace on the very first turn.
    registeredRuntimes = ['claude-code'];
    runtimesConfig = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
    };
    agentManifest = { runtime: 'codex', model: 'gpt-5.3-codex' };

    await createSessionRoomTurnRunner().run(request());

    // The server's default for the runtime it actually landed on — the only
    // value that can mean anything to that session.
    expect(triggered[0].settings).toEqual({ model: 'opus' });
    expect(persistSessionRuntime).toHaveBeenLastCalledWith(
      expect.any(String),
      'claude-code',
      '/repo/ana'
    );
  });

  it('still seeds that model once the runtime it was written for is registered', async () => {
    registeredRuntimes = ['claude-code', 'codex'];
    agentManifest = { runtime: 'codex', model: 'gpt-5.3-codex' };

    await createSessionRoomTurnRunner().run(request());

    expect(triggered[0].settings).toEqual({ model: 'gpt-5.3-codex' });
  });

  it("keeps the server's effort for an agent that only names a model", async () => {
    runtimesConfig = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: {
        ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
        defaultModel: 'opus',
        defaultEffort: 'high',
      },
    };
    agentManifest = { runtime: 'claude-code', model: 'sonnet' };

    await createSessionRoomTurnRunner().run(request());

    expect(triggered[0].settings).toEqual({ model: 'sonnet', effort: 'high' });
  });
});

/**
 * A room turn leaves a durable record, whatever runtime it ran on (DOR-784).
 *
 * Rooms are the one surface with nobody watching. Everywhere else a person is
 * holding `GET /api/sessions/:id/events` while the turn runs, so a failure is on
 * their screen; a room triggers a turn into the dark. On 2026-07-31 an agent
 * went quiet in a room for forty-one minutes and `session_events` held zero rows
 * about it — there was no way to tell whether the turn had run, failed, or never
 * started.
 *
 * The rows are a RECORD, never a history: claude-code's history is SDK JSONL and
 * stays there (ADR 260710-024641, as retired in part by 260731-211050). So the
 * second test here is as load-bearing as the
 * first — persisting the whole stream is the thing that ADR ruled out, and a
 * change that "fixed" the first test by turning on full persistence would put
 * every `text_delta` of every room turn in the database.
 */
describe('a room turn is recorded durably', () => {
  let store: SessionEventStoreInstance;

  beforeEach(() => {
    store = new SessionEventStore(createTestDb());
    setSessionEventStore(store);
    internalSessionId = () => undefined;
    turnBehaviour = saysAndCloses('green');
    getCapabilities.mockReturnValue(DECLARED_CAPABILITIES);
  });

  afterEach(() => {
    setSessionEventStore(undefined);
  });

  it('writes rows for a claude-code turn, which used to write none', async () => {
    const result = await createSessionRoomTurnRunner().run(request());

    const recorded = store.readAll(result.sessionId);
    expect(recorded.map((event: { type: string }) => event.type)).toEqual([
      'turn_start',
      'turn_end',
    ]);
  });

  it('keeps only the boundaries, so the transcript is not double-stored', async () => {
    turnBehaviour = saysAndCloses('Green', ' — ', 'nothing failed.');

    const result = await createSessionRoomTurnRunner().run(request());

    const recorded = store.readAll(result.sessionId);
    expect(recorded.some((event: { type: string }) => event.type === 'text_delta')).toBe(false);
  });

  it('records the failure of a turn that ended in an error', async () => {
    // The incident's actual question — did it run and break, or never run? The
    // terminal reason is the answer, and it is on the row.
    turnBehaviour = (opts) => {
      const { sessionId, projector } = opts;
      openTurn(opts);
      projector.ingest({ type: 'turn_end', terminalReason: 'error' });
      return { accepted: true, canonicalId: sessionId };
    };

    const result = await createSessionRoomTurnRunner().run(request());

    const recorded = store.readAll(result.sessionId);
    expect(recorded.at(-1)).toMatchObject({ type: 'turn_end', terminalReason: 'error' });
  });

  it('still stores a log-backed runtime in full, because there the rows ARE the history', async () => {
    getCapabilities.mockReturnValue({ ...DECLARED_CAPABILITIES, logBackedHistory: true });
    turnBehaviour = saysAndCloses('green');

    const result = await createSessionRoomTurnRunner().run(request());

    const recorded = store.readAll(result.sessionId);
    expect(recorded.some((event: { type: string }) => event.type === 'text_delta')).toBe(true);
  });
});
