import { describe, it, expect, vi } from 'vitest';
import type { OpencodeClient, GlobalEvent } from '@opencode-ai/sdk';
import { OpenCodeGlobalEventHub, TurnEventQueue } from '../global-event-hub.js';
import type { OpenCodeClientProvider } from '../session-mapper.js';
import {
  DIRECTORY,
  OC_SESSION_A,
  globalEvent,
  serverConnected,
  sessionIdle,
} from './opencode-sse-fixtures.js';

/** One fake `/global/event` connection (push-controlled, abort-aware). */
interface FakeConnection {
  push(event: GlobalEvent): void;
  fail(error: unknown): void;
}

/** Factory backing `client.global.event`: every call mints a FRESH connection. */
function makeGlobalSource() {
  const connections: FakeConnection[] = [];
  const impl = vi.fn(
    async (options?: { signal?: AbortSignal; onSseError?: (error: unknown) => void }) => {
      const queue = new TurnEventQueue<GlobalEvent>();
      options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
      connections.push({
        push: (event) => queue.push(event),
        fail: (error) => queue.fail(error),
      });
      return { stream: queue };
    }
  );
  return { impl, connections, latest: (): FakeConnection => connections[connections.length - 1]! };
}

function makeHub() {
  const source = makeGlobalSource();
  const client = { global: { event: source.impl } } as unknown as OpencodeClient;
  const provider: OpenCodeClientProvider = {
    getClient: vi.fn(async () => client),
    peekClient: vi.fn(() => client),
  };
  const hub = new OpenCodeGlobalEventHub(provider, 0);
  return { hub, source };
}

describe('OpenCodeGlobalEventHub', () => {
  it('resolves live off the running connection and fans events to listeners', async () => {
    const { hub, source } = makeHub();
    const received: GlobalEvent[] = [];
    const subscription = hub.subscribe({
      cwd: DIRECTORY,
      onEvent: (event) => received.push(event),
      onStreamDrop: () => undefined,
    });

    await vi.waitFor(() => expect(source.impl).toHaveBeenCalledTimes(1));
    source.latest().push(globalEvent(DIRECTORY, serverConnected()));
    await subscription.live;

    const idle = globalEvent(DIRECTORY, sessionIdle(OC_SESSION_A));
    source.latest().push(idle);
    await vi.waitFor(() => expect(received).toContain(idle));
    subscription.unsubscribe();
  });

  it('a subscriber arriving in the same tick as pump wind-down goes live only on a NEW connection', async () => {
    const { hub, source } = makeHub();

    // Turn 1's listener: establish connection 1 and go live.
    const first = hub.subscribe({
      cwd: DIRECTORY,
      onEvent: () => undefined,
      onStreamDrop: () => undefined,
    });
    await vi.waitFor(() => expect(source.impl).toHaveBeenCalledTimes(1));
    source.latest().push(globalEvent(DIRECTORY, serverConnected()));
    await first.live;

    // The turn-boundary window: the last listener leaves (aborting the
    // connection) and the next turn subscribes in the SAME tick.
    const received: GlobalEvent[] = [];
    const drops: unknown[] = [];
    let liveSettled = false;
    first.unsubscribe();
    const second = hub.subscribe({
      cwd: DIRECTORY,
      onEvent: (event) => received.push(event),
      onStreamDrop: (error) => drops.push(error),
    });
    void second.live.then(() => {
      liveSettled = true;
    });

    // The aborted connection is dead — it must NOT satisfy liveness, and the
    // pump winding down must not settle stragglers either.
    await Promise.resolve();
    expect(liveSettled).toBe(false);

    // The pump re-arms onto a NEW connection for the waiting subscriber…
    await vi.waitFor(() => expect(source.impl).toHaveBeenCalledTimes(2));
    // …which is established but not yet observably live: still not settled.
    expect(liveSettled).toBe(false);

    // First event on connection 2 resolves live; a prompt fired after `live`
    // therefore has its terminal (session.idle) delivered, never lost.
    source.latest().push(globalEvent(DIRECTORY, serverConnected()));
    await second.live;
    const idle = globalEvent(DIRECTORY, sessionIdle(OC_SESSION_A));
    source.latest().push(idle);
    await vi.waitFor(() => expect(received).toContain(idle));

    // Client-side wind-down is not a sidecar drop — no spurious failure.
    expect(drops).toEqual([]);
    second.unsubscribe();
  });

  it('notifies listeners and reconnects when the stream genuinely drops', async () => {
    const { hub, source } = makeHub();
    const drops: unknown[] = [];
    const subscription = hub.subscribe({
      cwd: DIRECTORY,
      onEvent: () => undefined,
      onStreamDrop: (error) => drops.push(error),
    });
    await vi.waitFor(() => expect(source.impl).toHaveBeenCalledTimes(1));
    source.latest().push(globalEvent(DIRECTORY, serverConnected()));
    await subscription.live;

    source.latest().fail(new Error('sidecar died'));
    await vi.waitFor(() => expect(drops).toHaveLength(1));

    // With the listener still attached, the hub resubscribes (fresh client).
    await vi.waitFor(() => expect(source.impl).toHaveBeenCalledTimes(2));
    subscription.unsubscribe();
  });
});
