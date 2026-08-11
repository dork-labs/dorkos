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
import { FakeAgentRuntime, createMockSession } from '@dorkos/test-utils';
import { SSE } from '../../../config/constants.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { EncodedBroadcast, FanOutClient } from '../../core/event-fan-out.js';
import { SessionListBroadcaster, sendSessionStatusSnapshot } from '../session-list-broadcaster.js';
import {
  getOrCreateProjector,
  disposeProjector,
  listProjectorStatuses,
  type RawSessionEvent,
} from '../session-state-projector.js';

// Sessions carry UUID ids per SessionSchema; non-UUID ids fail validation.
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_C = '33333333-3333-4333-8333-333333333333';

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
  let broadcastSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    broadcaster = new SessionListBroadcaster();
    runtimeA = new FakeAgentRuntime();
    runtimeB = new FakeAgentRuntime();
    broadcastSpy = vi.spyOn(eventFanOut, 'broadcast');
  });

  afterEach(async () => {
    await broadcaster.stop();
    vi.restoreAllMocks();
  });

  it('survives a MALFORMED upsert even with a retirement check armed', async () => {
    // The retirement check reads `session.id`. Doing that before schema
    // validation threw out of the consume loop and killed the runtime's entire
    // subscription — every later event silently lost. Validation is the gate;
    // nothing ahead of it may assume shape.
    const a = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    runtimeA.getInternalSessionId.mockImplementation((id: string) =>
      id === SESSION_A ? SESSION_B : undefined
    );

    broadcaster.start([runtimeA]);
    a.push({ type: 'session_upserted' } as unknown as SessionListEvent);
    // A valid event after the bad one proves the loop survived.
    a.push({ type: 'session_removed', sessionId: SESSION_A });

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_removed',
        expect.objectContaining({ sessionId: SESSION_A })
      );
    });
    expect(broadcastSpy).not.toHaveBeenCalledWith('session_upserted', expect.anything());
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

  it('still forwards session_removed for a retired id', async () => {
    // Telling a client to drop a row it should not be holding is always safe.
    const a = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    runtimeA.getInternalSessionId.mockImplementation((id: string) =>
      id === SESSION_A ? SESSION_B : undefined
    );

    broadcaster.start([runtimeA]);
    a.push({ type: 'session_removed', sessionId: SESSION_A });

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_removed',
        expect.objectContaining({ sessionId: SESSION_A })
      );
    });
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

  it('does not mutate the session object the adapter handed it', async () => {
    // Adapters emit the instance they hold — the Claude watcher pushes the very
    // object in its diff map, which is also the transcript reader's mtime-cached
    // entry. Overlaying in place would write display values into a runtime's own
    // cached state and defeat its change suppression.
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
    const adapterOwned = createMockSession({ id: SESSION_A, permissionMode: 'default' });

    broadcaster.start([runtimeA], settings);
    a.push({ type: 'session_upserted', session: adapterOwned });

    await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalled());
    expect(adapterOwned.permissionMode).toBe('default');
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

  it('every runtime failing at construction leaves the broadcaster stopped so a later start() retries', () => {
    const boom = (): AsyncIterable<SessionListEvent> => {
      throw new Error('watcher failed to start');
    };
    runtimeA.subscribeSessionList.mockImplementation(boom);
    runtimeB.subscribeSessionList.mockImplementation(boom);

    expect(() => broadcaster.start([runtimeA, runtimeB])).not.toThrow();

    // Discovery is fully off (running reset), so a retry re-subscribes both.
    runtimeA.subscribeSessionList.mockReturnValue(controllableSessionList().iterable);
    runtimeB.subscribeSessionList.mockReturnValue(controllableSessionList().iterable);
    broadcaster.start([runtimeA, runtimeB]);
    expect(runtimeA.subscribeSessionList).toHaveBeenCalledTimes(2);
    expect(runtimeB.subscribeSessionList).toHaveBeenCalledTimes(2);
  });

  it('projector liveness survives every watcher failing at construction', async () => {
    // The status fan-out is installed before (and independent of) the watchers.
    const boom = (): AsyncIterable<SessionListEvent> => {
      throw new Error('watcher failed to start');
    };
    runtimeA.subscribeSessionList.mockImplementation(boom);
    runtimeB.subscribeSessionList.mockImplementation(boom);
    broadcaster.start([runtimeA, runtimeB]);

    const projector = getOrCreateProjector(SESSION_A, '/work/alpha');
    projector.ingest({ type: 'turn_start' });
    disposeProjector(SESSION_A);

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_status',
        expect.objectContaining({
          sessionId: SESSION_A,
          cwd: '/work/alpha',
          status: expect.objectContaining({ lifecycle: 'streaming' }),
        })
      );
    });
  });

  it("one runtime's stream ending naturally does not stop the sibling runtime's broadcasting", async () => {
    const a = controllableSessionList();
    const b = controllableSessionList();
    runtimeA.subscribeSessionList.mockReturnValue(a.iterable);
    runtimeB.subscribeSessionList.mockReturnValue(b.iterable);
    broadcaster.start([runtimeA, runtimeB]);

    // Runtime A's stream ends cleanly; runtime B must keep broadcasting.
    a.end();
    b.push({ type: 'session_removed', sessionId: SESSION_B });

    await vi.waitFor(() => {
      expect(broadcastSpy).toHaveBeenCalledWith(
        'session_removed',
        expect.objectContaining({ sessionId: SESSION_B })
      );
    });

    // The broadcaster is still running for B: stop() must close B's iterator
    // (a shared running=false on A's exit would have made stop() return early).
    await broadcaster.stop();
    expect(b.returned()).toBe(true);
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
    sendSessionStatusSnapshot(congested.client);

    // Paired deliberately: "sent nothing" is worthless on its own, since a
    // registry with no non-idle projector in it would satisfy it too. The
    // healthy client is what proves there was something to send.
    const healthy = recordingClient();
    sendSessionStatusSnapshot(healthy.client);

    expect(congested.sessionIds()).toEqual([]);
    expect(healthy.sessionIds()).toEqual([SESSION_A]);
  });

  it('stops part-way rather than dropping the client', () => {
    errorProjector(SESSION_A);
    errorProjector(SESSION_B);
    errorProjector(SESSION_C);

    // Congested by its own first frame: the ceiling is crossed after one send,
    // so this walks the loop rather than failing its very first check.
    const client = recordingClient(SSE.MAX_BUFFERED_BYTES + 1);
    sendSessionStatusSnapshot(client.client);

    expect(client.sessionIds()).toHaveLength(1);
    // The opposite of what a broadcast does to a slow client, and deliberately:
    // one dropped here would reconnect straight into this same function and hit
    // the same ceiling. A partial preamble is the honest floor.
    expect(client.wasDropped()).toBe(false);
  });
});
