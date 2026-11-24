/**
 * Unit tests for the multi-runtime session-list fan-in (ADR-0310).
 *
 * `SessionListBroadcaster.start()` accepts every registered runtime and merges
 * each runtime's `subscribeSessionList` stream onto the single `eventFanOut`
 * broadcast. These tests drive hand-controlled async iterables to prove the
 * merge, the per-runtime synchronous-throw isolation (one runtime's watcher
 * failing at construction must not crash boot or kill the others), and the
 * lifecycle invariants (`stop()` closes every iterator; one stream ending does
 * not stop its siblings; the projector status fan-out survives watcher
 * failures). Wire-level SSE delivery is covered by
 * `routes/__tests__/events-status.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import { FakeAgentRuntime, createMockSession } from '@dorkos/test-utils';
import { SSE } from '../../../config/constants.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { EncodedBroadcast, FanOutClient } from '../../core/event-fan-out.js';
import {
  SessionListBroadcaster,
  sendSessionStatusSnapshot,
} from '../catalog/session-list-broadcaster.js';
import { fanOutAgentSessions, resetAgentSessionFanoutCache } from '../agent-session-fanout.js';
import {
  getOrCreateProjector,
  disposeProjector,
  listProjectorStatuses,
  type RawSessionEvent,
} from '../session-state-projector.js';

// Sessions carry UUID ids per SessionSchema; non-UUID ids fail validation.
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

/**
 * A hand-driven async iterable of session-list events. `push()` delivers the
 * next event (or buffers it); `end()`/`return()` terminates the stream. Lets a
 * test feed the broadcaster on its own schedule and observe `.return()` calls.
 */
function controllableSessionList(): {
  iterable: AsyncIterable<SessionListEvent>;
  push: (event: SessionListEvent) => void;
  end: () => void;
  returned: () => boolean;
} {
  const queue: SessionListEvent[] = [];
  let waiter: ((r: IteratorResult<SessionListEvent>) => void) | null = null;
  let done = false;
  let didReturn = false;

  const deliver = (result: IteratorResult<SessionListEvent>): void => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(result);
    }
  };

  return {
    returned: () => didReturn,
    push: (event) => {
      if (done) return;
      if (waiter) deliver({ value: event, done: false });
      else queue.push(event);
    },
    end: () => {
      done = true;
      deliver({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SessionListEvent>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              waiter = resolve;
            });
          },
          return(): Promise<IteratorResult<SessionListEvent>> {
            didReturn = true;
            done = true;
            deliver({ value: undefined, done: true });
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  };
}

describe('SessionListBroadcaster — multi-runtime fan-in (ADR-0310)', () => {
  let broadcaster: SessionListBroadcaster;
  let runtimeA: FakeAgentRuntime;
  let runtimeB: FakeAgentRuntime;
  /** What was broadcast, by name and payload; the audience is the asks suite's to check. */
  let broadcastSpy: ReturnType<typeof vi.fn<(name: string, data: unknown) => void>>;

  beforeEach(() => {
    broadcaster = new SessionListBroadcaster();
    runtimeA = new FakeAgentRuntime();
    runtimeB = new FakeAgentRuntime();
    broadcastSpy = vi.fn<(name: string, data: unknown) => void>();
    const broadcast = eventFanOut.broadcast.bind(eventFanOut);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name, data, audience) => {
      broadcastSpy(name, data);
      broadcast(name, data, audience);
    });
  });

  afterEach(async () => {
    await broadcaster.stop();
    vi.restoreAllMocks();
    resetAgentSessionFanoutCache();
  });

  it('marks the machine-wide fan-out stale on every upsert and removal', async () => {
    // Red when the wiring is lost: the fan-out then hands a caller asking
    // because of a new chat an answer scanned before that chat existed.
    const a = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    const lister = new FakeAgentRuntime('lister');
    lister.listSessions.mockResolvedValue([
      createMockSession({
        id: SESSION_A,
        cwd: '/agents/a0',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    const ask = () => fanOutAgentSessions({ runtimes: [lister], agentPaths: ['/agents/a0'] });
    await ask();
    await ask();
    expect(lister.listSessions).toHaveBeenCalledTimes(1);

    broadcaster.start([runtimeA]);
    a.push({ type: 'session_upserted', session: createMockSession({ id: SESSION_A }) });
    await vi.waitFor(() =>
      expect(broadcastSpy).toHaveBeenCalledWith('session_upserted', expect.anything())
    );
    await ask();
    expect(lister.listSessions).toHaveBeenCalledTimes(2);

    // An update to a chat already listed reuses the fresh answer (DOR-2893).
    broadcastSpy.mockClear();
    a.push({
      type: 'session_upserted',
      session: createMockSession({
        id: SESSION_A,
        title: 'Renamed',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    });
    await vi.waitFor(() =>
      expect(broadcastSpy).toHaveBeenCalledWith('session_upserted', expect.anything())
    );
    const answer = await ask();
    expect(lister.listSessions).toHaveBeenCalledTimes(2);
    expect(answer.perPath[0]!.members[0]!.title).toBe('Renamed');

    a.push({ type: 'session_removed', sessionId: SESSION_A });
    await vi.waitFor(() =>
      expect(broadcastSpy).toHaveBeenCalledWith('session_removed', expect.anything())
    );
    await ask();
    expect(lister.listSessions).toHaveBeenCalledTimes(3);
  });

  it('suppresses an upsert for an id the runtime has RETIRED', async () => {
    // `aggregateSessionList` drops retired ids from every listing; this stream
    // is the OTHER producer of client-visible rows, so it must agree — otherwise
    // a row the list refuses to show arrives over SSE moments later.
    const a = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    runtimeA.getInternalSessionId.mockImplementation((id: string) =>
      id === SESSION_A ? SESSION_B : undefined
    );

    broadcaster.start([runtimeA]);
    a.push({ type: 'session_upserted', session: createMockSession({ id: SESSION_A }) });
    // A live, non-retired session behind it proves the loop kept running rather
    // than stalling on the suppressed event.
    a.push({ type: 'session_upserted', session: createMockSession({ id: SESSION_B }) });

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_upserted',
        expect.objectContaining({ session: expect.objectContaining({ id: SESSION_B }) })
      );
    });
    expect(broadcastSpy).not.toHaveBeenCalledWith(
      'session_upserted',
      expect.objectContaining({ session: expect.objectContaining({ id: SESSION_A }) })
    );
  });

  it('overlays persisted settings onto a broadcast session_upserted', async () => {
    // This stream — not GET /api/sessions — is what keeps a client's session
    // list current: the cold-load query has no poll, so every later refresh of a
    // row arrives here. Un-overlaid, an upsert OVERWRITES the operator's stored
    // permission mode in the client's cache with the runtime-derived one, which
    // is the same disagreement DOR-463 fixed on the HTTP endpoints (the sidebar
    // row's bypass warning reads exactly this field).
    const a = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    const settings = {
      getSessionSettingsMany: vi.fn(
        () => new Map([[SESSION_A, { permissionMode: 'bypassPermissions' as const }]])
      ),
      has: () => true,
      get: () => ({
        getInternalSessionId: () => undefined,
        // Every registered runtime declares whether it takes an effort; these
        // sessions carry none, so the declaration only has to be present.
        getCapabilities: () => ({ settings: { supportsEffort: true } }),
      }),
    };

    broadcaster.start([runtimeA], settings);
    // The runtime reports the transcript-derived mode.
    a.push({
      type: 'session_upserted',
      session: createMockSession({ id: SESSION_A, permissionMode: 'default' }),
    });

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_upserted',
        expect.objectContaining({
          session: expect.objectContaining({
            id: SESSION_A,
            permissionMode: 'bypassPermissions',
          }),
        })
      );
    });
  });

  it('broadcasts as-is when the settings store throws — stale beats invisible', async () => {
    const a = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    const settings = {
      getSessionSettingsMany: vi.fn(() => {
        throw new Error('settings store unavailable');
      }),
      has: () => true,
      get: () => ({
        getInternalSessionId: () => undefined,
        // Every registered runtime declares whether it takes an effort; these
        // sessions carry none, so the declaration only has to be present.
        getCapabilities: () => ({ settings: { supportsEffort: true } }),
      }),
    };

    broadcaster.start([runtimeA], settings);
    a.push({
      type: 'session_upserted',
      session: createMockSession({ id: SESSION_A, permissionMode: 'default' }),
    });

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_upserted',
        expect.objectContaining({ session: expect.objectContaining({ id: SESSION_A }) })
      );
    });
  });

  it('stamps room origin onto a broadcast session_upserted, so a room turn never reaches a client as human', async () => {
    // DOR-1141. The overlays ran on the REST routes and nowhere else, so the
    // record this stream pushed carried no origin at all — and every consumer of
    // the human-origin liveness rule (§18: the palette's Continue list, the
    // sidebar's live rollups) counted a freshly triggered room turn as the
    // operator's own conversation until the next REST refetch corrected it.
    const a = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    broadcaster.setOriginResolvers({
      resolveRoomOrigins: (ids) =>
        ids.includes(SESSION_A)
          ? new Map([[SESSION_A, { roomLabel: '#general', roomId: 'room-general' }]])
          : new Map(),
    });

    broadcaster.start([runtimeA]);
    a.push({
      type: 'session_upserted',
      // What a runtime reports: an ordinary session, with a reading the room
      // post it was triggered by looks exactly like a person having typed.
      session: createMockSession({
        id: SESSION_A,
        userLastMessageAt: '2026-03-01T09:00:00.000Z',
      }),
    });

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_upserted',
        expect.objectContaining({
          session: expect.objectContaining({ id: SESSION_A, origin: 'room' }),
        })
      );
    });
    const [, upsert] = broadcastSpy.mock.calls.find(
      (call: unknown[]) => call[0] === 'session_upserted'
    )!;
    const { session } = upsert as { session: Session };
    expect(session.originLabel).toBe('#general');
    // BC-16: the reading came from another agent's post, so it is taken back
    // here exactly as the REST routes take it back.
    expect('userLastMessageAt' in session).toBe(false);
  });

  it('carries trackerItems and the deprecated trackerItem on a live upsert, like GET /api/sessions (D10)', async () => {
    const a = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    const items = [
      {
        id: 'DOR-2',
        stage: 'execute',
        runStatus: 'running',
        startedAt: '2026-09-28T10:00:00.000Z',
        via: 'own-chat' as const,
        ownChatSessionId: SESSION_B,
      },
      {
        id: 'DOR-1',
        stage: 'verify',
        runStatus: 'running',
        startedAt: '2026-09-28T09:00:00.000Z',
        via: 'this-chat' as const,
        ownChatSessionId: null,
      },
    ];
    broadcaster.setTrackerItemsOverlay(async (page) => {
      for (const session of page) {
        if (session.id !== SESSION_A) continue;
        session.trackerItems = items;
        session.trackerItem = { id: 'DOR-2', stage: 'execute', runStatus: 'running' };
      }
    });

    broadcaster.start([runtimeA]);
    a.push({ type: 'session_upserted', session: createMockSession({ id: SESSION_A }) });
    a.push({ type: 'session_removed', sessionId: SESSION_A });

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith('session_removed', expect.anything());
    });
    const names = broadcastSpy.mock.calls.map((call: unknown[]) => call[0]);
    // The overlay is asynchronous, and one runtime's events still keep their order.
    expect(names.indexOf('session_upserted')).toBeLessThan(names.indexOf('session_removed'));
    const [, upsert] = broadcastSpy.mock.calls.find(
      (call: unknown[]) => call[0] === 'session_upserted'
    )!;
    const { session } = upsert as { session: Session };
    expect(session.trackerItems).toEqual(items);
    expect(session.trackerItem).toEqual({ id: 'DOR-2', stage: 'execute', runStatus: 'running' });
  });

  it('merges session-list events from every runtime onto the single fan-out', async () => {
    const a = controllableSessionList();
    const b = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    runtimeB.subscribeSessionList.mockReturnValue(b.iterable);

    broadcaster.start([runtimeA, runtimeB]);
    a.push({ type: 'session_upserted', session: createMockSession({ id: SESSION_A }) });
    b.push({ type: 'session_removed', sessionId: SESSION_B });

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_upserted',
        expect.objectContaining({ session: expect.objectContaining({ id: SESSION_A }) })
      );
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_removed',
        expect.objectContaining({ sessionId: SESSION_B })
      );
    });

    // Each runtime received its own subscription with the global discovery ctx.
    const globalCtx = expect.objectContaining({
      cwd: expect.any(String),
      permissionMode: 'default',
    });
    expect(runtimeA.subscribeSessionList).toHaveBeenCalledTimes(1);
    expect(runtimeA.subscribeSessionList).toHaveBeenCalledWith(globalCtx);
    expect(runtimeB.subscribeSessionList).toHaveBeenCalledTimes(1);
    expect(runtimeB.subscribeSessionList).toHaveBeenCalledWith(globalCtx);
  });

  it("one runtime throwing synchronously at construction leaves the other runtime's discovery live", async () => {
    const b = controllableSessionList();
    runtimeA.subscribeSessionList.mockImplementation(() => {
      throw new Error('chokidar failed to start');
    });
    runtimeB.subscribeSessionList.mockReturnValue(b.iterable);

    // The server must stay up: start() swallows the per-runtime throw.
    expect(() => broadcaster.start([runtimeA, runtimeB])).not.toThrow();

    b.push({ type: 'session_removed', sessionId: SESSION_B });
    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_removed',
        expect.objectContaining({ sessionId: SESSION_B })
      );
    });

    // running state is coherent: the broadcaster is live (runtime B), so a
    // second start() is a no-op and does not re-subscribe either runtime.
    broadcaster.start([runtimeA, runtimeB]);
    expect(runtimeA.subscribeSessionList).toHaveBeenCalledTimes(1);
    expect(runtimeB.subscribeSessionList).toHaveBeenCalledTimes(1);
  });

  it("stop() closes every runtime's iterator via return()", async () => {
    const a = controllableSessionList();
    const b = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    runtimeB.subscribeSessionList.mockReturnValue(b.iterable);

    broadcaster.start([runtimeA, runtimeB]);
    await broadcaster.stop();

    expect(a.returned()).toBe(true);
    expect(b.returned()).toBe(true);
  });

  it('re-subscribes after stop(), which is what makes a live account switch work', async () => {
    // Relied on by `runtimes/claude-code/account-switch.ts`: each watcher
    // captured the OLD Claude projects roots when it was constructed, so the
    // whole mechanism for applying an account switch without a restart is
    // stop-then-start re-invoking `subscribeSessionList`. Pinned here rather than
    // assumed, because `start()` no-ops while the broadcaster is still running —
    // a `stop()` that left `running` set would make the restart silently do
    // nothing and leave every watcher on the old accounts.
    const first = controllableSessionList();
    const second = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValueOnce(first.iterable);
    runtimeA.subscribeSessionList.mockReturnValueOnce(second.iterable);

    broadcaster.start([runtimeA]);
    await broadcaster.stop();
    broadcaster.start([runtimeA]);

    expect(runtimeA.subscribeSessionList).toHaveBeenCalledTimes(2);
    // The NEW stream is the live one: an event on it reaches clients.
    second.push({ type: 'session_removed', sessionId: SESSION_A });
    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_removed',
        expect.objectContaining({ sessionId: SESSION_A })
      );
    });
  });
});

/**
 * The connect preamble's bound.
 *
 * `sendSessionStatusSnapshot` is the one place the global stream writes N frames
 * in a row, and N is "every non-idle projector" — which on codex and opencode is
 * a set nothing evicts on a timer. The ceiling is what keeps that from filling
 * process memory for a client that is not reading, and it is the half of the
 * function no wire-level test can reach: `routes/__tests__/events-status.test.ts`
 * drives a real socket, which never congests with a handful of frames.
 */
describe('sendSessionStatusSnapshot — the connect preamble', () => {
  /** A {@link FanOutClient} that records, and whose buffer grows per send. */
  function recordingClient(bytesPerSend = 0, initialBuffered = 0) {
    const frames: EncodedBroadcast[] = [];
    let buffered = initialBuffered;
    let dropped = false;
    const client: FanOutClient = {
      send: (broadcast) => {
        frames.push(broadcast);
        buffered += bytesPerSend;
      },
      get bufferedBytes() {
        return buffered;
      },
      get gone() {
        return false;
      },
      drop: () => {
        dropped = true;
      },
    };
    return {
      client,
      /** Session ids the client was told about, in order. */
      sessionIds: () =>
        frames.map(
          (frame) => (JSON.parse(frame.sse.split('data: ')[1]!) as { sessionId: string }).sessionId
        ),
      wasDropped: () => dropped,
    };
  }

  /** Drive a projector to a turn that ended in an error. */
  function errorProjector(sessionId: string): void {
    const projector = getOrCreateProjector(sessionId, '/work/alpha');
    projector.ingest({ type: 'turn_start' });
    projector.ingest({ type: 'turn_end', terminalReason: 'error' } as RawSessionEvent);
  }

  // The registry is module-global and this function reads ALL of it, so a
  // projector another test left behind would land in these counts. Clearing
  // both ways keeps the assertions about what THIS test created.
  const clearRegistry = (): void => {
    for (const entry of listProjectorStatuses()) disposeProjector(entry.sessionId);
  };
  beforeEach(clearRegistry);
  afterEach(clearRegistry);

  it('sends nothing to a client already over the buffer ceiling — and everything to one under it', () => {
    errorProjector(SESSION_A);

    const congested = recordingClient(0, SSE.MAX_BUFFERED_BYTES + 1);
    sendSessionStatusSnapshot(congested.client, { kind: 'operator' });

    // Paired deliberately: "sent nothing" is worthless on its own, since a
    // registry with no non-idle projector in it would satisfy it too. The
    // healthy client is what proves there was something to send.
    const healthy = recordingClient();
    sendSessionStatusSnapshot(healthy.client, { kind: 'operator' });

    expect(congested.sessionIds()).toEqual([]);
    expect(healthy.sessionIds()).toEqual([SESSION_A]);
  });
});
