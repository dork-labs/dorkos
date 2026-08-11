/**
 * The queue as it actually reaches a browser: over `GET /api/sessions/:id/events`
 * (spec `persistent-session-runtime` task 2.5).
 *
 * The sibling suite (`sessions-events.test.ts`) pins the stream's SEQUENCING
 * with a mocked snapshot, which is the right tool for cursor arithmetic and the
 * wrong one here — a mocked snapshot can report any queue at all. So these cases
 * wire the fake runtime's snapshot and subscribe straight through to the REAL
 * projector over a REAL SQLite queue store, and assert what a window is told:
 *
 * - a cold connect hydrates the queue with everything in the store, in order,
 * - a change made anywhere reaches an already-open stream as `queue_update`,
 * - and a reconnect with `Last-Event-ID` replays those updates gap-free.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime, collectDurableEvents } from '@dorkos/test-utils';
import type { SessionEvent, SessionSnapshot } from '@dorkos/shared/session-stream';
import type { SessionOpts } from '@dorkos/shared/agent-runtime';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {
    constructor(
      public readonly runtime: string,
      public readonly sessionId: string
    ) {
      super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
      this.name = 'RuntimeNotRegisteredError';
    }
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));

import { createApp, finalizeApp } from '../../app.js';
import { STREAM_EPOCH } from '../../lib/stream-cursor.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import {
  emitQueueUpdate,
  resetMessageDispatcher,
} from '../../services/session/message-dispatcher.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';

const app = createApp();
finalizeApp(app);

const SESSION_ID = '00000000-0000-4000-8000-0000000000aa';
const TAB = 'window-a';

let store: MessageQueueStore;
/** Runs once the cold snapshot has been captured — where a live case mutates. */
let afterSnapshot: (() => void) | undefined;

beforeEach(() => {
  store = new MessageQueueStore(createTestDb());
  setMessageQueueStore(store);
  afterSnapshot = undefined;
  fakeRuntime = new FakeAgentRuntime();
  fakeRuntime.hasSession.mockReturnValue(true);
  // The real projector behind both halves of the stream contract, so what the
  // route serves is what the server actually holds.
  fakeRuntime.getSessionSnapshot = vi.fn(
    async (_ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> => {
      const snapshot = await getOrCreateProjector(sessionId).buildSnapshot(async () => []);
      // Deferred so the mutation lands AFTER the snapshot is captured — the
      // cold connect then subscribes from its cursor and replays the event,
      // which is the same gap-free guarantee a live window relies on.
      if (afterSnapshot) queueMicrotask(afterSnapshot);
      return snapshot;
    }
  );
  fakeRuntime.subscribeSession = vi.fn(
    (
      _ctx: SessionOpts,
      sessionId: string,
      sinceCursor?: number,
      signal?: AbortSignal
    ): AsyncIterable<SessionEvent> =>
      getOrCreateProjector(sessionId).subscribe(sinceCursor ?? 0, signal)
  );
});

afterEach(() => {
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(SESSION_ID);
  vi.restoreAllMocks();
});

/** Queue `count` messages and hand back their contents in dispatch order. */
function seedQueue(...contents: string[]): void {
  for (const content of contents) {
    store.enqueue({ sessionId: SESSION_ID, content, clientId: TAB });
  }
}

describe('GET /api/sessions/:id/events — the queue on the wire', () => {
  it('a cold connect hydrates the whole queue, in order, in the snapshot frame', async () => {
    seedQueue('first', 'second', 'third');

    const { frames } = await collectDurableEvents(app, SESSION_ID, {
      until: (f) => f.some((frame) => frame.event === 'snapshot'),
    });

    const snapshot = frames[0]?.data as SessionSnapshot;
    expect(frames[0]?.event).toBe('snapshot');
    expect(snapshot.queuedMessages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    expect(snapshot.queuedMessages.map((m) => m.enqueuedBy)).toEqual([TAB, TAB, TAB]);
    // Exactly what the store holds — no second request needed to learn it.
    expect(snapshot.queuedMessages.map((m) => m.id)).toEqual(
      store.list(SESSION_ID).map((row) => row.id)
    );
  });

  it('an enqueue in another window arrives as queue_update carrying the full queue', async () => {
    seedQueue('already waiting');
    afterSnapshot = () => {
      store.enqueue({ sessionId: SESSION_ID, content: 'typed in window B', clientId: 'window-b' });
      emitQueueUpdate(SESSION_ID);
    };

    const { frames } = await collectDurableEvents(app, SESSION_ID, {
      until: (f) => f.some((frame) => frame.event === 'queue_update'),
    });

    const update = frames.find((f) => f.event === 'queue_update');
    const event = update?.data as Extract<SessionEvent, { type: 'queue_update' }>;
    expect(event.queue.map((m) => m.content)).toEqual(['already waiting', 'typed in window B']);
    expect(event.queue[1]?.enqueuedBy).toBe('window-b');
    // Stamped and addressable like any other event on the stream.
    expect(update?.id).toBe(`${SESSION_ID}-${STREAM_EPOCH}-${event.seq}`);
  });

  it('a removal in another window arrives as queue_update without the removed message', async () => {
    seedQueue('keep me', 'never mind');
    const doomed = store.list(SESSION_ID)[1]!.id;
    afterSnapshot = () => {
      store.remove(doomed);
      emitQueueUpdate(SESSION_ID);
    };

    const { frames } = await collectDurableEvents(app, SESSION_ID, {
      until: (f) => f.some((frame) => frame.event === 'queue_update'),
    });

    const event = frames.find((f) => f.event === 'queue_update')?.data as Extract<
      SessionEvent,
      { type: 'queue_update' }
    >;
    expect(event.queue.map((m) => m.content)).toEqual(['keep me']);
  });

  it('a degraded acceptance carries requested, applied, and degradedBecause', async () => {
    afterSnapshot = () => {
      const row = store.enqueue({
        sessionId: SESSION_ID,
        content: 'also check the tests',
        clientId: TAB,
        disposition: 'steer',
      });
      emitQueueUpdate(SESSION_ID, {
        messageId: row.id,
        requested: 'steer',
        applied: 'queue',
        degradedBecause: 'unsupported',
      });
    };

    const { frames } = await collectDurableEvents(app, SESSION_ID, {
      until: (f) => f.some((frame) => frame.event === 'queue_update'),
    });

    const event = frames.find((f) => f.event === 'queue_update')?.data as Extract<
      SessionEvent,
      { type: 'queue_update' }
    >;
    expect(event.outcome).toEqual({
      messageId: event.queue[0]!.id,
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'unsupported',
    });
  });
});

describe('GET /api/sessions/:id/events — resuming across queue updates', () => {
  it('replays queue_update in sequence, gap-free, and sends no second snapshot', async () => {
    const projector = getOrCreateProjector(SESSION_ID);
    seedQueue('one');
    emitQueueUpdate(SESSION_ID); // seq 1
    projector.ingest({ type: 'turn_start' }); // seq 2
    seedQueue('two');
    emitQueueUpdate(SESSION_ID); // seq 3
    projector.ingest({ type: 'turn_end' }); // seq 4

    const { frames } = await collectDurableEvents(app, SESSION_ID, {
      lastEventId: `${SESSION_ID}-${STREAM_EPOCH}-1`,
      until: (f) => f.some((frame) => frame.id?.endsWith('-4')),
    });

    expect(frames.some((f) => f.event === 'snapshot')).toBe(false);
    expect(frames.map((f) => f.event)).toEqual(['turn_start', 'queue_update', 'turn_end']);
    expect(frames.map((f) => f.id)).toEqual([
      `${SESSION_ID}-${STREAM_EPOCH}-2`,
      `${SESSION_ID}-${STREAM_EPOCH}-3`,
      `${SESSION_ID}-${STREAM_EPOCH}-4`,
    ]);
    const replayed = frames[1]?.data as Extract<SessionEvent, { type: 'queue_update' }>;
    expect(replayed.queue.map((m) => m.content)).toEqual(['one', 'two']);
  });

  it('a cursor from a dead server process still falls back to a cold snapshot that carries the queue', async () => {
    // The epoch check and the StaleResumeCursorError fallback are untouched by
    // the new event: an unservable cursor still hydrates from scratch, and the
    // queue rides that hydration rather than being lost with the cursor.
    seedQueue('survived the restart');

    const { frames } = await collectDurableEvents(app, SESSION_ID, {
      lastEventId: `${SESSION_ID}-${STREAM_EPOCH - 1}-4523`,
      until: (f) => f.some((frame) => frame.event === 'snapshot'),
    });

    const snapshot = frames[0]?.data as SessionSnapshot;
    expect(frames[0]?.event).toBe('snapshot');
    expect(snapshot.cursor).toBe(0);
    expect(snapshot.queuedMessages.map((m) => m.content)).toEqual(['survived the restart']);
  });
});
