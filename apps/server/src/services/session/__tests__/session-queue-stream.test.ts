/**
 * The queue as every window sees it (spec `persistent-session-runtime` task 2.5).
 *
 * Task 2.3 made the queue real but private: rows went into SQLite and came out
 * again at dispatch, and nothing on the wire ever said so. These cases pin the
 * three things that make it public — the snapshot carries it, every mutation
 * announces it, and a restart neither loses it nor duplicates it.
 *
 * The store is real SQLite throughout, because "your message survived" is the
 * promise and a fake would assert the promise against itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { Db } from '@dorkos/db';

// The neutral context bag is assembled off the real filesystem (git status);
// nothing here cares about context, so keep it inert.
vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  adoptQueuedMessages,
  dispatchMessage,
  emitQueueUpdate,
  listQueuedMessages,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
} from '../session-state-projector.js';
import type { RawSessionEvent } from '../session-state-projector.js';

const TAB = 'window-a';

let db: Db;
let store: MessageQueueStore;
let runtime: FakeAgentRuntime;
let session: string;
let sessionCounter = 0;
/** Projector ids to dispose beyond the case's own session. */
let extraProjectors: string[];

/** Let queued microtasks and the pump's deferral drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A turn that ends immediately. */
function quickTurn(order?: string[]) {
  return async function* (): AsyncGenerator<StreamEvent> {
    order?.push('turn');
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** A turn that streams a token, parks on `hold`, then ends cleanly. */
function heldTurn(hold: Promise<void>) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
    await hold;
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** Collect every event a projector ingests from now on. */
function watch(sessionId: string): SessionEvent[] {
  const seen: SessionEvent[] = [];
  const projector = getOrCreateProjector(sessionId);
  void (async () => {
    for await (const event of projector.subscribe(projector.getCursor())) seen.push(event);
  })();
  return seen;
}

beforeEach(() => {
  sessionCounter += 1;
  session = `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, '0')}`;
  extraProjectors = [];
  db = createTestDb();
  store = new MessageQueueStore(db);
  setMessageQueueStore(store);
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
});

afterEach(async () => {
  await settle();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(session);
  for (const id of extraProjectors) disposeProjector(id);
  vi.restoreAllMocks();
});

describe('the snapshot carries the queue', () => {
  it('reads the store, in dispatch order, with nothing server-side leaking onto the wire', async () => {
    for (const content of ['first', 'second', 'third']) {
      store.enqueue({ sessionId: session, content, clientId: TAB });
    }

    const snapshot = await getOrCreateProjector(session).buildSnapshot(async () => []);

    expect(snapshot.queuedMessages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    expect(Object.keys(snapshot.queuedMessages[0]!).sort()).toEqual([
      'content',
      'disposition',
      'enqueuedAt',
      'enqueuedBy',
      'id',
    ]);
  });

  it('is empty when nothing is queued, and when no store is wired at all', async () => {
    const projector = getOrCreateProjector(session);
    expect((await projector.buildSnapshot(async () => [])).queuedMessages).toEqual([]);

    setMessageQueueStore(undefined);
    expect((await projector.buildSnapshot(async () => [])).queuedMessages).toEqual([]);
  });

  it('still finds the queue after the session gains its canonical id', async () => {
    const canonical = `${session}-canonical`;
    extraProjectors.push(canonical);
    getOrCreateProjector(session);
    store.enqueue({ sessionId: session, content: 'typed under the request uuid', clientId: TAB });

    rekeyProjector(session, canonical);

    const snapshot = await getOrCreateProjector(canonical).buildSnapshot(async () => []);
    expect(snapshot.queuedMessages.map((m) => m.content)).toEqual(['typed under the request uuid']);
  });
});

describe('emitQueueUpdate — every mutation announces the whole queue', () => {
  it('carries the full queue and a seq like any other event', async () => {
    const seen = watch(session);
    store.enqueue({ sessionId: session, content: 'one', clientId: TAB });
    store.enqueue({ sessionId: session, content: 'two', clientId: TAB });

    emitQueueUpdate(session);
    await settle();

    expect(seen).toHaveLength(1);
    const event = seen[0]!;
    expect(event.type).toBe('queue_update');
    expect(event.seq).toBeGreaterThan(0);
    expect(event.type === 'queue_update' && event.queue.map((m) => m.content)).toEqual([
      'one',
      'two',
    ]);
    expect(event.type === 'queue_update' && event.outcome).toBeUndefined();
  });

  it('carries the outcome when an accepted message caused it', async () => {
    const seen = watch(session);
    const row = store.enqueue({
      sessionId: session,
      content: 'also check the tests',
      clientId: TAB,
      disposition: 'steer',
    });

    emitQueueUpdate(session, {
      messageId: row.id,
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'unsupported',
    });
    await settle();

    const event = seen[0]!;
    expect(event.type === 'queue_update' && event.outcome).toEqual({
      messageId: row.id,
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'unsupported',
    });
  });

  it('announces a removal — the other window learns the message is gone', async () => {
    const row = store.enqueue({ sessionId: session, content: 'never mind', clientId: TAB });
    const seen = watch(session);

    store.remove(row.id);
    emitQueueUpdate(session);
    await settle();

    expect(seen[0]?.type === 'queue_update' && seen[0].queue).toEqual([]);
  });

  it('says nothing when no projector is listening, and when no store is wired', async () => {
    setMessageQueueStore(undefined);
    expect(() => emitQueueUpdate(session)).not.toThrow();

    setMessageQueueStore(store);
    store.enqueue({ sessionId: session, content: 'nobody is watching', clientId: TAB });
    const projector = getOrCreateProjector(session);
    const before = projector.getCursor();
    setMessageQueueStore(undefined);
    emitQueueUpdate(session);
    expect(projector.getCursor()).toBe(before);
  });
});

describe('a queue_update is not part of the conversation', () => {
  it('does not reopen a closed turn and does not become part of an open one', async () => {
    const projector = getOrCreateProjector(session);
    store.enqueue({ sessionId: session, content: 'waiting', clientId: TAB });

    // Idle: the queue changing must not make the session look like it is talking.
    emitQueueUpdate(session);
    expect(projector.getStatus().lifecycle).toBe('idle');
    expect(projector.peekInProgressTurn()).toBeNull();

    // Mid-turn: it rides the stream, but the turn's own events are the turn's.
    projector.ingest({ type: 'turn_start' });
    projector.ingest({ type: 'text_delta', text: 'thinking' } as RawSessionEvent);
    emitQueueUpdate(session);

    expect(projector.peekInProgressTurn()?.map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
    ]);
    expect(projector.getStatus().lifecycle).toBe('streaming');
  });
});

describe('the dispatcher announces its own mutations', () => {
  it('announces the acceptance with its outcome, then the dispatch that emptied the queue', async () => {
    const first = { open: () => {}, wait: Promise.resolve() };
    let openFirst!: () => void;
    first.wait = new Promise<void>((resolve) => {
      openFirst = resolve;
    });
    runtime.withScenarios([heldTurn(first.wait), quickTurn()]);

    const projector = getOrCreateProjector(session);
    void dispatchMessage({
      sessionId: session,
      clientId: TAB,
      content: 'long turn',
      projector,
      runtime,
    });
    await settle();

    const seen = watch(session);
    const queued = dispatchMessage({
      sessionId: session,
      clientId: TAB,
      content: 'queued behind it',
      disposition: 'steer',
      projector,
      runtime,
    });
    await settle();

    const accepted = seen.filter((e) => e.type === 'queue_update');
    expect(accepted).toHaveLength(1);
    expect(
      accepted[0]!.type === 'queue_update' && accepted[0]!.queue.map((m) => m.content)
    ).toEqual(['queued behind it']);
    expect(accepted[0]!.type === 'queue_update' && accepted[0]!.outcome).toMatchObject({
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'unsupported',
    });

    openFirst();
    await queued;
    await settle();

    const updates = seen.filter((e) => e.type === 'queue_update');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const last = updates.at(-1)!;
    expect(last.type === 'queue_update' && last.queue).toEqual([]);
    expect(last.type === 'queue_update' && last.outcome).toBeUndefined();
  });
});

describe('a restart adopts the rows it finds — it never re-offers them', () => {
  it('dispatches all three in order, keeping their ids, with no duplicate rows', async () => {
    for (const content of ['one', 'two', 'three']) {
      store.enqueue({ sessionId: session, content, clientId: TAB });
    }
    const idsBefore = store.list(session).map((row) => row.id);
    runtime.withScenarios([quickTurn(), quickTurn(), quickTurn()]);

    // The restart analog: no in-memory dispatcher state at all, only the rows.
    resetMessageDispatcher();
    const projector = getOrCreateProjector(session);

    // A cold connect sees all three, in the order the person left them.
    const snapshot = await projector.buildSnapshot(async () => []);
    expect(snapshot.queuedMessages.map((m) => m.content)).toEqual(['one', 'two', 'three']);

    const adopted = adoptQueuedMessages({ sessionId: session, projector, runtime });
    expect(adopted).toBe(3);
    // Adoption alone must never enqueue anything: same rows, same ids.
    expect(store.list(session).map((row) => row.id)).toEqual(idsBefore);

    for (let i = 0; i < 6; i++) await settle();

    expect(runtime.sendMessage.mock.calls.map((call) => call[1])).toEqual(['one', 'two', 'three']);
    expect(
      runtime.sendMessage.mock.calls.map((call) => (call[2] as { messageId?: string }).messageId)
    ).toEqual(idsBefore);
    expect(store.list(session)).toEqual([]);
    expect(listQueuedMessages(session)).toEqual([]);
  });

  it('recovers on the next dispatch too, without a caller having to remember', async () => {
    // The automatic half: nobody calls adoption explicitly on the message path,
    // so a person who simply carries on typing after a restart must still find
    // their older words running rather than stranded behind the new one.
    for (const content of ['left behind one', 'left behind two']) {
      store.enqueue({ sessionId: session, content, clientId: TAB });
    }
    const strandedIds = store.list(session).map((row) => row.id);
    runtime.withScenarios([quickTurn(), quickTurn(), quickTurn()]);
    resetMessageDispatcher();

    await dispatchMessage({
      sessionId: session,
      clientId: 'a-window-opened-after-the-restart',
      content: 'typed after the restart',
      projector: getOrCreateProjector(session),
      runtime,
    });
    for (let i = 0; i < 6; i++) await settle();

    expect(runtime.sendMessage.mock.calls.map((call) => call[1])).toEqual([
      'typed after the restart',
      'left behind one',
      'left behind two',
    ]);
    // Adopted, not re-offered: the surviving rows kept their ids and no row was
    // ever written twice.
    expect(
      runtime.sendMessage.mock.calls
        .slice(1)
        .map((call) => (call[2] as { messageId?: string }).messageId)
    ).toEqual(strandedIds);
    expect(store.list(session)).toEqual([]);
  });

  it('is idempotent — adopting twice does not run anything twice', async () => {
    store.enqueue({ sessionId: session, content: 'only once', clientId: TAB });
    let openTurn!: () => void;
    const held = new Promise<void>((resolve) => {
      openTurn = resolve;
    });
    runtime.withScenarios([heldTurn(held), quickTurn()]);
    const projector = getOrCreateProjector(session);

    expect(adoptQueuedMessages({ sessionId: session, projector, runtime })).toBe(1);
    expect(adoptQueuedMessages({ sessionId: session, projector, runtime })).toBe(0);
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    openTurn();
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('the queue survives the canonical-id rename as ONE queue', () => {
  it('keeps a message enqueued after the rename beside the ones from before it', async () => {
    const canonical = `${session}-canonical`;
    extraProjectors.push(canonical);
    let openFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      openFirst = resolve;
    });
    runtime.withScenarios([heldTurn(held), quickTurn(), quickTurn()]);
    const projector = getOrCreateProjector(session);

    void dispatchMessage({
      sessionId: session,
      clientId: TAB,
      content: 'long turn',
      projector,
      runtime,
    });
    await settle();
    const before = dispatchMessage({
      sessionId: session,
      clientId: TAB,
      content: 'typed before the rename',
      projector,
      runtime,
    });
    await settle();

    rekeyProjector(session, canonical);
    runtime.getInternalSessionId.mockReturnValue(canonical);

    const after = dispatchMessage({
      sessionId: canonical,
      clientId: TAB,
      content: 'typed after the rename',
      projector,
      runtime,
    });
    await settle();

    // One queue, not two: both messages are visible under the live id, in order.
    expect(listQueuedMessages(canonical).map((m) => m.content)).toEqual([
      'typed before the rename',
      'typed after the rename',
    ]);
    const snapshot = await getOrCreateProjector(canonical).buildSnapshot(async () => []);
    expect(snapshot.queuedMessages.map((m) => m.content)).toEqual([
      'typed before the rename',
      'typed after the rename',
    ]);

    openFirst();
    await before;
    await after;
  });
});
