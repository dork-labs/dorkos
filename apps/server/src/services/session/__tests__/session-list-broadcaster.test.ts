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
import { eventFanOut } from '../../core/event-fan-out.js';
import { SessionListBroadcaster } from '../session-list-broadcaster.js';
import { getOrCreateProjector, disposeProjector } from '../session-state-projector.js';

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
});
