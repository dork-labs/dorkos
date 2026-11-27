/**
 * Every device reads a chat's status from its run record (spec
 * `turns-survive-restarts` §4.6, §7.3, §7.4, DOR-5212): `run_update` on the
 * chat's durable stream, `SessionSnapshot.runs`, `GET /api/sessions/:id/runs`,
 * and the restored draft.
 *
 * Real SQLite, real run record, real queue store, real projector and the real
 * `deliverSessionStream`; only the runtime under the stream is a double, bound
 * to the real projector, because the frames a window receives are what is
 * observed. A "kill" is what a crash leaves: the turn still open on the stream,
 * its run still `running`, owned by a boot that is gone and whose lease ran out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sessionMessageQueue, turnRuns, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { SessionOpts } from '@dorkos/shared/agent-runtime';
import type { CapabilityInvocationContext } from '../../core/capabilities/index.js';
import type { ChatRun } from '@dorkos/shared/run-schemas';
import type { SessionEvent, SessionSnapshot } from '@dorkos/shared/session-stream';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import {
  MessageQueueStore,
  moveQueueRowToSession,
  setMessageQueueStore,
} from '../../session/message-queue-store.js';
import { chatClientId } from '@dorkos/shared/chat-client-id';
import { disposeProjector, getOrCreateProjector } from '../../session/session-state-projector.js';
import {
  adoptQueuedMessages,
  listQueuedMessages,
  resetMessageDispatcher,
} from '../../session/message-dispatcher.js';
import {
  cancelQueuedMessage,
  clearQueuedMessages,
  editQueuedMessage,
} from '../../session/queued-message-edits.js';
import type { DurableStreamSink } from '../../core/streams/durable-stream-sink.js';
import { deliverSessionStream } from '../../core/streams/screen/session-stream-delivery.js';
import { installRunRecord, uninstallRunRecord } from '../index.js';
import { chatRunsPage } from '../run-capabilities.js';
import { RUN_LEASE_MS, RunStore } from '../run-store.js';

const EPOCH = '01BOOTEPOCHVIEW00000000000';
const DEAD_EPOCH = '01DEADBOOTVIEW000000000000';
const CTX = { cwd: '/demo/project' } as SessionOpts;

let db: Db;
let queue: MessageQueueStore;
let runs: RunStore;
let sessionId: string;
let clock: number;

/** A sink that keeps every frame, the way a window would see them. */
class Window implements DurableStreamSink {
  readonly frames: StreamFrame[] = [];
  closed = false;
  private readonly abort = new AbortController();
  readonly signal = this.abort.signal;

  async send(frame: StreamFrame): Promise<void> {
    this.frames.push(frame);
  }

  end(): void {
    this.closed = true;
  }

  /** Close this window. */
  leave(): void {
    this.closed = true;
    this.abort.abort();
  }

  snapshot(): SessionSnapshot {
    const frame = this.frames.find((f) => f.event === 'snapshot');
    if (!frame) throw new Error('no snapshot frame was sent');
    return frame.data as SessionSnapshot;
  }

  /** The runs the newest `run_update` this window received carried. */
  lastRunUpdate(): ChatRun[] | undefined {
    const frame = this.frames.filter((f) => f.event === 'run_update').at(-1);
    return (frame?.data as Extract<SessionEvent, { type: 'run_update' }> | undefined)?.runs;
  }
}

/** A runtime whose stream is the real projector's, as every real runtime's is. */
function runtimeOverProjector(): FakeAgentRuntime {
  const runtime = new FakeAgentRuntime('view-demo');
  runtime.getSessionSnapshot.mockImplementation(async (_ctx, id) =>
    getOrCreateProjector(id).buildSnapshot(async () => [])
  );
  runtime.subscribeSession.mockImplementation((_ctx, id, since, signal) =>
    getOrCreateProjector(id).subscribe(since ?? 0, signal)
  );
  return runtime;
}

/** Open a window on the chat and wait for its snapshot. */
async function openWindow(runtime: FakeAgentRuntime): Promise<Window> {
  const window = new Window();
  void deliverSessionStream(window, {
    sessionId,
    runtime,
    ctx: CTX,
    resume: undefined,
    principal: { kind: 'operator' },
  });
  await vi.waitFor(() => expect(window.frames.some((f) => f.event === 'snapshot')).toBe(true));
  return window;
}

/** Let microtasks and timer-0 callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * What a crash leaves: a turn open on the chat's stream, and its run still
 * `running`, owned by a boot that is gone and whose lease ran out.
 */
function aTurnACrashCut(): { runId: string; turnSeq: number } {
  const projector = getOrCreateProjector(sessionId);
  const turnStart = projector.ingest({ type: 'turn_start' });
  const gone = new RunStore(db, { epoch: DEAD_EPOCH, now: () => clock - 2 * RUN_LEASE_MS });
  const run = gone.create({
    chatKey: sessionId,
    status: 'running',
    openedBy: 'caller',
    origin: null,
    runtimeTurnRef: turnStart.seq,
  });
  return { runId: run.id, turnSeq: turnStart.seq };
}

beforeEach(() => {
  db = createTestDb();
  queue = new MessageQueueStore(db);
  setMessageQueueStore(queue);
  clock = Date.parse('2026-11-25T09:00:00.000Z');
  // This boot holds every run it owns: only the gone boot's run is dead.
  runs = installRunRecord(db, { epoch: EPOCH, now: () => clock, ownerHolds: () => true });
  sessionId = crypto.randomUUID();
});

afterEach(() => {
  resetMessageDispatcher();
  uninstallRunRecord();
  setMessageQueueStore(undefined);
  disposeProjector(sessionId);
  vi.restoreAllMocks();
});

describe('a turn whose process died, as every window reads it', () => {
  it('a second window shows its ending and its line, not "working"', async () => {
    const runtime = runtimeOverProjector();
    const { runId, turnSeq } = aTurnACrashCut();
    const first = await openWindow(runtime);
    // The stream alone still says the turn runs: no `turn_end` ever came.
    expect(first.snapshot().status.lifecycle).toBe('streaming');

    const second = await openWindow(runtime);

    const shown = second.snapshot();
    expect(shown.inProgressTurn?.[0]).toMatchObject({ type: 'turn_start', seq: turnSeq });
    expect(shown.runs).toEqual([
      expect.objectContaining({
        id: runId,
        status: 'ended',
        ending: 'process_died',
        notice: 'restart_stopped',
        runtimeTurnRef: turnSeq,
      }),
    ]);
    // The first window, already open, hears the same thing on its stream.
    await vi.waitFor(() =>
      expect(first.lastRunUpdate()).toEqual([
        expect.objectContaining({ id: runId, status: 'ended', notice: 'restart_stopped' }),
      ])
    );
    // A run update is about the chat, never part of the turn's transcript.
    const third = await openWindow(runtime);
    expect(third.snapshot().inProgressTurn?.some((e) => e.type === 'run_update')).toBe(false);
    for (const window of [first, second, third]) window.leave();
  });

  it('drops the line once anything newer is sent, and never shows it for a turn that ended well', async () => {
    const runtime = runtimeOverProjector();
    aTurnACrashCut();
    const window = await openWindow(runtime);
    expect(window.snapshot().runs?.at(-1)?.notice).toBe('restart_stopped');

    const next = runs.create({
      chatKey: sessionId,
      status: 'queued',
      openedBy: 'caller',
      origin: null,
    });

    await vi.waitFor(() => expect(window.lastRunUpdate()?.at(-1)?.id).toBe(next.id));
    expect(window.lastRunUpdate()?.at(-1)).toMatchObject({ status: 'queued', notice: null });
    // The run it waits on goes live and finishes on its own: no line.
    const live = runs.move(runs.move(next, 'starting', runs.lease()), 'started', runs.lease());
    runs.endTurn(runs.move(live, 'running'), 'completed');
    await vi.waitFor(() =>
      expect(window.lastRunUpdate()).toEqual([
        expect.objectContaining({
          id: next.id,
          status: 'ended',
          ending: 'completed',
          notice: null,
        }),
      ])
    );
    window.leave();
  });
});

describe('which ending gets the restart line', () => {
  /** A run a boot that is gone was running, ended as `ending`. */
  function endedInAGoneBoot(ending: 'process_died' | 'shutdown') {
    const gone = new RunStore(db, { epoch: DEAD_EPOCH, now: () => clock - 2 * RUN_LEASE_MS });
    const run = gone.create({
      chatKey: sessionId,
      status: 'running',
      openedBy: 'caller',
      origin: null,
    });
    gone.endTurn(run, ending);
    return run.id;
  }
  const lineOf = () => chatRunsPage({ id: sessionId, limit: 50 }).runs.at(-1)?.notice;

  it('a reply a graceful restart ended gets it, as one a crash ended does', () => {
    endedInAGoneBoot('shutdown');
    expect(lineOf()).toBe('restart_stopped');
  });

  it('follows recovery once it decides the run', () => {
    const runId = endedInAGoneBoot('process_died');
    db.update(turnRuns)
      .set({ recoveryDecidedAt: new Date(clock).toISOString() })
      .where(eq(turnRuns.id, runId))
      .run();
    expect(lineOf()).toBeNull();
  });

  it('never claims a restart for a run this boot owned', () => {
    const own = runs.create({
      chatKey: sessionId,
      status: 'running',
      openedBy: 'caller',
      origin: null,
    });
    // What retirement writes for this boot's own run whose owner is gone (a failed write).
    runs.endTurn(own, 'process_died');
    expect(lineOf()).toBeNull();
  });

  it('in the lease window, shows the gone boot’s run as the record holds it, and no turn as open', async () => {
    const gone = new RunStore(db, { epoch: DEAD_EPOCH, now: () => clock });
    gone.create({ chatKey: sessionId, status: 'running', openedBy: 'caller', origin: null });
    const window = await openWindow(runtimeOverProjector());
    // Not retired yet: its lease has not run out (§7.1). The stream this boot
    // serves opened no turn, so no window reads it as working.
    expect(window.snapshot().runs?.map((run) => run.status)).toEqual(['running']);
    expect(window.snapshot().status.lifecycle).toBe('idle');
    expect(window.snapshot().inProgressTurn).toBeNull();
    window.leave();
  });
});

describe('run_update', () => {
  it('goes out when a run changes without a status move', async () => {
    const window = await openWindow(runtimeOverProjector());
    const run = runs.create({
      chatKey: sessionId,
      status: 'queued',
      openedBy: 'caller',
      origin: null,
    });
    const live = runs.move(runs.move(run, 'starting', runs.lease()), 'started', runs.lease());
    runs.move(live, 'running');
    await settle();

    runs.annotate(run.id, { waitingOnPerson: true });

    await vi.waitFor(() =>
      expect(window.lastRunUpdate()).toEqual([expect.objectContaining({ waitingOnPerson: true })])
    );
    window.leave();
  });

  it('goes out when the queue is reordered, with each waiting run’s new place', async () => {
    const window = await openWindow(runtimeOverProjector());
    const origin = { kind: 'interactive' } as const;
    const first = queue.enqueue({ sessionId, content: 'one', clientId: 'web-w', origin });
    const second = queue.enqueue({ sessionId, content: 'two', clientId: 'web-w', origin });
    await settle();
    const places = () =>
      window.lastRunUpdate()?.map((run) => [run.queueMessageId, run.queuePosition]);
    expect(places()).toEqual([
      [first.id, 1],
      [second.id, 2],
    ]);

    queue.move(second.id, { before: first.id });

    await vi.waitFor(() =>
      expect(places()).toEqual([
        [first.id, 2],
        [second.id, 1],
      ])
    );
    window.leave();
  });

  it('goes out on both chats when a waiting row moves to another chat', async () => {
    const window = await openWindow(runtimeOverProjector());
    const row = queue.enqueue({
      sessionId,
      content: 'moving',
      clientId: 'web-w',
      origin: { kind: 'interactive' },
    });
    await settle();
    expect(window.lastRunUpdate()).toHaveLength(1);

    db.transaction((tx) => moveQueueRowToSession(tx, row.id, crypto.randomUUID()));

    await vi.waitFor(() => expect(window.lastRunUpdate()).toEqual([]));
    window.leave();
  });

  it('carries the chat’s live run and its waiting runs, whole, after every status change', async () => {
    const window = await openWindow(runtimeOverProjector());
    const head = runs.create({
      chatKey: sessionId,
      status: 'queued',
      openedBy: 'caller',
      origin: null,
    });
    const behind = runs.create({
      chatKey: sessionId,
      status: 'queued',
      openedBy: 'caller',
      origin: null,
    });
    await settle();
    // One transaction's changes go out once, read after it commits.
    runs.move(head, 'starting', runs.lease());
    await vi.waitFor(() =>
      expect(window.lastRunUpdate()?.map((run) => [run.id, run.status])).toEqual([
        [head.id, 'starting'],
        [behind.id, 'queued'],
      ])
    );
    expect(window.lastRunUpdate()?.[1]).toMatchObject({ waitReason: null, waitingOnPerson: false });
    window.leave();
  });
});

describe('GET /api/sessions/:id/runs', () => {
  it('pages the same list the snapshot carries', () => {
    const made = [1, 2, 3].map(() =>
      runs.create({ chatKey: sessionId, status: 'queued', openedBy: 'caller', origin: null })
    );
    const first = chatRunsPage({ id: sessionId, limit: 2 });
    expect(first.runs.map((run) => run.id)).toEqual([made[0]!.id, made[1]!.id]);
    expect(first.nextCursor).not.toBeNull();
    const rest = chatRunsPage({ id: sessionId, limit: 2, cursor: first.nextCursor! });
    expect(rest).toEqual({
      runs: [expect.objectContaining({ id: made[2]!.id })],
      nextCursor: null,
    });
  });

  it('answers an agent the same 404 as a missing chat for a chat it may not read', () => {
    const agent = { agentIdentityPresented: true } as CapabilityInvocationContext;
    expect(() => chatRunsPage({ id: sessionId, limit: 50 }, agent)).toThrow(
      expect.objectContaining({ payload: expect.objectContaining({ code: 'SESSION_NOT_FOUND' }) })
    );
  });

  it('says DorkOS is still starting before the record is wired', () => {
    uninstallRunRecord();
    expect(() => chatRunsPage({ id: sessionId, limit: 50 })).toThrow(
      expect.objectContaining({
        payload: { code: 'NOT_READY', error: 'DorkOS is still starting.' },
      })
    );
  });
});

describe('a restored draft', () => {
  /**
   * What recovery (T15) leaves: a run that ended `process_died` from
   * `started`, beside its queue row in state `restored`.
   */
  function aRestoredDraft(): { rowId: string; runId: string } {
    const row = queue.enqueue({
      sessionId,
      content: 'words a restart handed back',
      clientId: 'web-person-window',
      disposition: 'queue',
      context: null,
    });
    const gone = new RunStore(db, { epoch: DEAD_EPOCH, now: () => clock - 2 * RUN_LEASE_MS });
    const queued = gone.create({
      chatKey: sessionId,
      status: 'queued',
      openedBy: 'caller',
      origin: null,
      queueMessageId: row.id,
    });
    const started = gone.move(gone.move(queued, 'starting', gone.lease()), 'started', gone.lease());
    gone.endTurn(started, 'process_died');
    db.update(sessionMessageQueue)
      .set({ state: 'restored' })
      .where(eq(sessionMessageQueue.id, row.id))
      .run();
    return { rowId: row.id, runId: started.id };
  }

  it('is listed, flagged, for every window, and never waits in line', async () => {
    const { rowId } = aRestoredDraft();
    const waiting = queue.enqueue({
      sessionId,
      content: 'a message in line',
      clientId: 'web-person-window',
    });

    expect(listQueuedMessages(sessionId)).toEqual([
      expect.objectContaining({ id: rowId, restored: true, canRestoreToComposer: true }),
      expect.not.objectContaining({ restored: true }),
    ]);
    const window = await openWindow(runtimeOverProjector());
    expect(window.snapshot().queuedMessages.map((row) => [row.id, row.restored])).toEqual([
      [rowId, true],
      [waiting.id, undefined],
    ]);
    // What the pump, adoption, Stop and the editors read never holds it.
    expect(queue.list(sessionId).map((row) => row.id)).toEqual([waiting.id]);
    expect(queue.getWaiting(rowId)).toBeUndefined();
    expect(editQueuedMessage(sessionId, rowId, { content: 'reworded' })).toBeUndefined();
    window.leave();
  });

  it('is never started by adoption, and outlives a Stop', async () => {
    const { rowId } = aRestoredDraft();
    const runtime = new FakeAgentRuntime('view-demo');

    expect(
      adoptQueuedMessages({ sessionId, projector: getOrCreateProjector(sessionId), runtime })
    ).toBe(0);
    clearQueuedMessages(sessionId);
    await settle();

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(queue.get(rowId)).toMatchObject({ restored: true });
  });

  it('discarding deletes the row and leaves its ended run as it was', () => {
    const { rowId, runId } = aRestoredDraft();
    const before = runs.get(runId);

    expect(cancelQueuedMessage(sessionId, rowId)).toMatchObject({ id: rowId, restored: true });

    expect(queue.get(rowId)).toBeUndefined();
    expect(listQueuedMessages(sessionId)).toEqual([]);
    expect(runs.get(runId)).toEqual(before);
    expect(before).toMatchObject({ status: 'ended', ending: 'process_died' });
  });

  it('gets no restart line: the runtime may never have read its words', () => {
    aRestoredDraft();
    expect(chatRunsPage({ id: sessionId, limit: 50 }).runs).toEqual([
      expect.objectContaining({ status: 'ended', ending: 'process_died', notice: null }),
    ]);
  });

  it('tolerates a flagged row another chat sent: listed, never offered to a composer', () => {
    const row = queue.enqueue({
      sessionId,
      content: 'words from another chat',
      clientId: chatClientId(crypto.randomUUID()),
    });
    db.update(sessionMessageQueue)
      .set({ state: 'restored' })
      .where(eq(sessionMessageQueue.id, row.id))
      .run();

    const [listed] = listQueuedMessages(sessionId);
    expect(listed).toMatchObject({ id: row.id, restored: true });
    expect(listed?.canRestoreToComposer).toBeUndefined();
  });

  it('a row a turn still holds (`in_turn`) stays hidden, unlike a restored one', () => {
    const row = queue.enqueue({
      sessionId,
      content: 'mid-turn words',
      clientId: 'web-person-window',
    });
    queue.markInTurn(row.id);
    expect(listQueuedMessages(sessionId)).toEqual([]);
  });
});
