import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));

/**
 * Where the frames come from, for this file only.
 *
 * `agent-activity.ts` reads the stream through `subscribeEventStream`, so that
 * one call is the seam: with a stand-in behind it a test hands the counter
 * frames directly and every assertion is true the instant the call returns —
 * nothing to poll, nothing to out-wait. `null` puts the real transport back for
 * the single socket test at the bottom of the file.
 *
 * Everything else `event-stream.ts` exports (`parseEventPayload`, which decides
 * whether a payload is JSON at all) stays real: this fakes where the frames
 * arrive from, never what they mean.
 */
const seam = vi.hoisted(() => ({
  subscribe: null as
    | null
    | ((
        options: { getPort: () => number | null },
        handlers: {
          onFrame: (frame: { name: string; data: string }) => void;
          onConnectionLost?: () => void;
        }
      ) => { unsubscribe: () => void }),
}));

vi.mock('../event-stream', async (importActual) => {
  const actual = await importActual<typeof import('../event-stream')>();
  return {
    ...actual,
    subscribeEventStream: (
      options: Parameters<typeof actual.subscribeEventStream>[0],
      handlers: Parameters<typeof actual.subscribeEventStream>[1]
    ) => (seam.subscribe ?? actual.subscribeEventStream)(options, handlers),
  };
});

import {
  getActiveAgentCount,
  watchAgentActivity,
  type AgentActivityCounts,
  type AgentActivityWatch,
} from '../agent-activity';
import type { EventStreamHandlers, EventStreamSubscription, GetServerPort } from '../event-stream';
import { deferred, FakeEventStream } from './fake-event-stream';

/** One `watchAgentActivity` subscription, as the fake source sees it. */
interface FakeSubscription {
  /** What the watcher wants to hear about the stream. */
  readonly handlers: EventStreamHandlers;
  /** The accessor the watcher subscribed with, so a test can prove it was passed through. */
  readonly getPort: GetServerPort;
  /** Whether the watcher has let go. */
  unsubscribed: boolean;
}

/**
 * The event stream with the wire taken out of it.
 *
 * Frames are delivered by a direct call, so a test asserts on the very next
 * line rather than waiting for a socket to get around to it — which is the
 * whole point (DOR-1727): what this file is about is which frames change the
 * count, and that question has no time in it. The frame shape is
 * `ServerEventFrame`, exactly what `event-stream.ts` hands its subscribers
 * after parsing the wire; that the real transport really does produce these
 * from real SSE text is the job of `event-stream.test.ts`, and of the one
 * socket test at the bottom of this file.
 */
class FakeEventSource {
  /** Every subscription made since this source was created, in order. */
  readonly subscriptions: FakeSubscription[] = [];

  /**
   * Stand in for `subscribeEventStream`.
   *
   * @param options - Where the watcher would find the server's port.
   * @param handlers - The watcher's frame and connection-lost callbacks.
   */
  subscribe = (
    options: { getPort: GetServerPort },
    handlers: EventStreamHandlers
  ): EventStreamSubscription => {
    const subscription: FakeSubscription = {
      handlers,
      getPort: options.getPort,
      unsubscribed: false,
    };
    this.subscriptions.push(subscription);
    return {
      unsubscribe: () => {
        subscription.unsubscribed = true;
      },
    };
  };

  /** The subscriptions that have not let go — nothing is delivered to the rest. */
  get live(): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => !subscription.unsubscribed);
  }

  /**
   * Deliver one frame to every live subscriber, synchronously.
   *
   * @param name - The event name, as the SSE `event:` line carried it.
   * @param data - The raw payload, still JSON text — or deliberately not JSON.
   */
  emit(name: string, data: string): void {
    for (const subscription of this.live) subscription.handlers.onFrame({ name, data });
  }

  /**
   * Deliver one named event with a JSON payload, as `eventFanOut.broadcast` writes it.
   *
   * @param name - The event name.
   * @param payload - The object to serialise into the frame's `data`.
   */
  emitEvent(name: string, payload: unknown): void {
    this.emit(name, JSON.stringify(payload));
  }

  /**
   * Deliver a `session_status` event, exactly as `session-list-broadcaster.ts` writes it.
   *
   * @param sessionId - Which session changed.
   * @param lifecycle - What it changed to.
   */
  sendStatus(sessionId: string, lifecycle: string): void {
    this.emitEvent('session_status', { type: 'session_status', sessionId, status: { lifecycle } });
  }

  /** Tell every live subscriber the connection is gone, as a server restart would. */
  dropConnection(): void {
    for (const subscription of this.live) subscription.handlers.onConnectionLost?.();
  }
}

let source: FakeEventSource;
let watch: AgentActivityWatch | null = null;

beforeEach(() => {
  source = new FakeEventSource();
  seam.subscribe = source.subscribe;
});

afterEach(() => {
  // `stop()` is also what clears the module-level session map between tests.
  watch?.stop();
  watch = null;
  seam.subscribe = null;
});

/**
 * Start watching the fake source.
 *
 * @param onChange - The counts callback, defaulting to a fresh spy.
 * @returns That callback, for the assertions.
 */
function start(onChange = vi.fn()): ReturnType<typeof vi.fn> {
  watch = watchAgentActivity({ getPort: () => 4242, onChange });
  return onChange;
}

describe('watchAgentActivity', () => {
  it('starts at zero, because nothing is running when the server has just come up', () => {
    start();
    expect(getActiveAgentCount()).toBe(0);
  });

  it('counts a session that starts streaming', () => {
    const onChange = start();

    source.sendStatus('session-a', 'streaming');

    expect(getActiveAgentCount()).toBe(1);
    expect(onChange).toHaveBeenLastCalledWith({ streaming: 1, blocked: 0 });
  });

  it('counts a session blocked on you — mid-turn is mid-turn, but apart from streaming', () => {
    const onChange = start();

    source.sendStatus('session-a', 'blocked');

    expect(getActiveAgentCount()).toBe(1);
    expect(onChange).toHaveBeenLastCalledWith({ streaming: 0, blocked: 1 });
  });

  it('moves a session between the streaming and blocked counts as its lifecycle changes', () => {
    const onChange = start();
    source.sendStatus('session-a', 'streaming');
    expect(onChange).toHaveBeenLastCalledWith({ streaming: 1, blocked: 0 });

    source.sendStatus('session-a', 'blocked');

    expect(onChange).toHaveBeenLastCalledWith({ streaming: 0, blocked: 1 });
    // Still exactly one agent mid-run — it just changed which count it's in.
    expect(getActiveAgentCount()).toBe(1);
  });

  it.each(['idle', 'error', 'interrupted'])(
    'stops counting a session that goes %s',
    (lifecycle) => {
      start();
      source.sendStatus('session-a', 'streaming');
      expect(getActiveAgentCount()).toBe(1);

      source.sendStatus('session-a', lifecycle);

      expect(getActiveAgentCount()).toBe(0);
    }
  );

  it('counts each session once, however many transitions it reports', () => {
    start();

    source.sendStatus('session-a', 'streaming');
    source.sendStatus('session-a', 'blocked');
    source.sendStatus('session-b', 'streaming');

    expect(getActiveAgentCount()).toBe(2);
  });

  it('stops counting a session that is removed while it was working', () => {
    start();
    source.sendStatus('session-a', 'streaming');
    expect(getActiveAgentCount()).toBe(1);

    source.emitEvent('session_removed', { type: 'session_removed', sessionId: 'session-a' });

    expect(getActiveAgentCount()).toBe(0);
  });

  it('only reports a change when either count actually changed', () => {
    const onChange = start();

    source.sendStatus('session-a', 'streaming');
    expect(onChange).toHaveBeenCalledTimes(1);
    // Re-announcing the same lifecycle for the same session is a no-op, and so
    // is a session going idle that was never counted in the first place.
    source.sendStatus('session-a', 'streaming');
    source.sendStatus('session-b', 'idle');
    source.sendStatus('session-b', 'streaming');

    expect(onChange.mock.calls).toEqual([
      [{ streaming: 1, blocked: 0 }],
      [{ streaming: 2, blocked: 0 }],
    ]);
  });

  it('ignores heartbeats, connect frames and anything else on the stream', () => {
    const onChange = start();

    source.emit('heartbeat', '');
    source.emit('connected', JSON.stringify({ connectedAt: '2026-07-26T00:00:00.000Z' }));
    source.emit('relay_message', JSON.stringify({ foo: 1 }));
    source.emit('session_status', 'not json');
    source.emit('session_status', JSON.stringify({ sessionId: 'a' }));
    source.sendStatus('session-a', 'streaming');

    expect(getActiveAgentCount()).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('forgets what it can no longer verify when the connection is lost', () => {
    const onChange = start();
    source.sendStatus('session-a', 'streaming');
    expect(getActiveAgentCount()).toBe(1);

    source.dropConnection();

    // A stale count that never clears would nag about agents that finished
    // long ago and block quitting forever, so a lost stream resets to zero.
    // (That the connection then comes BACK is `event-stream.ts`'s contract,
    // and is proven in `event-stream.test.ts`.)
    expect(getActiveAgentCount()).toBe(0);
    expect(onChange).toHaveBeenLastCalledWith({ streaming: 0, blocked: 0 });
  });

  it('subscribes with the caller’s port accessor rather than a port read once', () => {
    let port: number | null = null;
    watch = watchAgentActivity({ getPort: () => port, onChange: vi.fn() });

    // The crash-recovery dialog can restart the server onto a NEW port, so what
    // reaches the stream has to be the accessor itself, re-read per attempt.
    const subscription = source.subscriptions.at(-1);
    expect(subscription?.getPort()).toBeNull();
    port = 4242;
    expect(subscription?.getPort()).toBe(4242);
  });

  it('stops for good once stopped — and the silence afterwards is the stop, not a dead harness', () => {
    const onChange = start();
    source.sendStatus('session-a', 'streaming');
    expect(getActiveAgentCount()).toBe(1);

    watch?.stop();
    watch = null;

    expect(getActiveAgentCount()).toBe(0);
    // `stop()` forgetting the count while leaving the subscription open is the
    // leak that only ever showed up as collateral damage in whatever case ran
    // next (DOR-1730), so the subscription itself is the assertion.
    expect(source.live).toHaveLength(0);

    const callsAtStop = onChange.mock.calls.length;
    source.sendStatus('session-b', 'streaming');
    expect(getActiveAgentCount()).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(callsAtStop);

    // Positive control for the two did-not-happen assertions above: the very
    // same emit reaches a fresh watch and counts. So the silence was `stop()`
    // letting go, and not a source that had quietly stopped delivering
    // anything to anyone.
    const afterStop = vi.fn();
    watch = watchAgentActivity({ getPort: () => 4242, onChange: afterStop });
    source.sendStatus('session-c', 'streaming');
    expect(getActiveAgentCount()).toBe(1);
    expect(afterStop).toHaveBeenLastCalledWith({ streaming: 1, blocked: 0 });
  });
});

describe('watchAgentActivity over a real socket', () => {
  /**
   * The one test in this file that opens a socket, and the only reason the rest
   * can be trusted: it proves the seam above is wired to something real — a
   * `session_status` frame written to a real SSE response, over a real TCP
   * connection, through the real `event-stream.ts`, moves the real count.
   *
   * It waits on barriers the production code trips (the server's own request
   * handler; the watcher's own callback), never on a deadline, so there is no
   * budget for a loaded machine to spend. The package's `testTimeout` still
   * bounds a genuine hang. If it ever does flake, DELETE it rather than raising
   * anything — every behaviour it touches is asserted exactly, above and in
   * `event-stream.test.ts`, and a socket test that has to be nursed is worth
   * less than the noise it makes (DOR-1777).
   */
  it('counts an agent off a real SSE connection', async () => {
    seam.subscribe = null;
    const stream = new FakeEventStream();
    await stream.listen();
    const counted = deferred();
    const onChange = vi.fn((counts: AgentActivityCounts) => {
      if (counts.streaming === 1) counted.resolve();
    });

    try {
      watch = watchAgentActivity({ getPort: () => stream.port, onChange });
      await stream.connected();

      stream.sendStatus('session-a', 'streaming');

      await counted.promise;
      expect(getActiveAgentCount()).toBe(1);
    } finally {
      watch?.stop();
      watch = null;
      await stream.close();
    }
  });
});
