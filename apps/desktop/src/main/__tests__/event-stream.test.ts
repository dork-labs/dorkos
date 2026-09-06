import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

import { watchAgentActivity, type AgentActivityWatch } from '../agent-activity';
import { watchNotifications, type NotificationsWatch } from '../notifications';
import {
  nextReconnectDelayMs,
  subscribeEventStream,
  RECONNECT_BASE_MS,
  type EventStreamHandlers,
  type EventStreamSubscription,
  type GetServerPort,
  type ServerEventFrame,
} from '../event-stream';
import type {
  NativeNotificationHandle,
  NativeNotificationSpec,
  NotificationHost,
} from '../notifications/wrapper';
import { deferred, FakeEventStream } from './fake-event-stream';

/**
 * A `NotificationHost` double — this test only cares that a shown count moves,
 * not what's shown. {@link shows} is the barrier a test waits on, so nothing
 * here needs a deadline.
 */
class NoopNotificationHost implements NotificationHost {
  shownCount = 0;
  private waiters: { at: number; resolve: () => void }[] = [];
  isSupported(): boolean {
    return true;
  }
  show(_spec: NativeNotificationSpec): NativeNotificationHandle {
    this.shownCount += 1;
    const reached = this.waiters.filter((waiter) => waiter.at <= this.shownCount);
    this.waiters = this.waiters.filter((waiter) => waiter.at > this.shownCount);
    for (const waiter of reached) waiter.resolve();
    return { close: () => {} };
  }
  /**
   * Resolve once `count` notifications have been shown in total.
   *
   * @param count - The running total to wait for.
   */
  async shows(count: number): Promise<void> {
    if (this.shownCount >= count) return;
    await new Promise<void>((resolve) => this.waiters.push({ at: count, resolve }));
  }
}

/**
 * Every frame a subscriber has been handed, with a barrier per event name.
 *
 * The waits in this file are all of the form "until the stream delivers X",
 * and X is delivered by the production code itself — so the wait ends on that
 * delivery rather than on the next tick of a polling budget a busy machine
 * could exhaust (DOR-1727). A delivery that never comes is caught by the
 * package's `testTimeout`.
 */
class FrameLog {
  readonly frames: ServerEventFrame[] = [];
  private waiters: { name: string; resolve: (frame: ServerEventFrame) => void }[] = [];

  /** Record one frame. Pass this straight as a subscriber's `onFrame`. */
  record = (frame: ServerEventFrame): void => {
    this.frames.push(frame);
    const reached = this.waiters.filter((waiter) => waiter.name === frame.name);
    this.waiters = this.waiters.filter((waiter) => waiter.name !== frame.name);
    for (const waiter of reached) waiter.resolve(frame);
  };

  /** The event names recorded so far, in order. */
  get names(): string[] {
    return this.frames.map((frame) => frame.name);
  }

  /**
   * Resolve once a frame with this event name has arrived (immediately if one has).
   *
   * @param name - The event name to wait for.
   * @returns The first frame carrying it.
   */
  async arrives(name: string): Promise<ServerEventFrame> {
    const already = this.frames.find((frame) => frame.name === name);
    if (already) return already;
    return await new Promise<ServerEventFrame>((resolve) => this.waiters.push({ name, resolve }));
  }
}

let stream: FakeEventStream;
let activityWatch: AgentActivityWatch | null = null;
let notificationsWatch: NotificationsWatch | null = null;
const subscriptions: EventStreamSubscription[] = [];

/**
 * Subscribe, and leave the letting-go to `afterEach`.
 *
 * The module keeps its connection in module-level state, so a subscriber that
 * is never dropped stops the NEXT test from ever connecting. Cleaning up here
 * rather than in each test's `finally` is what keeps one red test from
 * cascading: a test that never settles never runs its own `finally`, but
 * `afterEach` runs regardless.
 *
 * @param getPort - Where to find the server's port right now.
 * @param handlers - What this subscriber wants to hear.
 * @returns The subscription, for tests that let go early on purpose.
 */
function subscribe(getPort: GetServerPort, handlers: EventStreamHandlers): EventStreamSubscription {
  const subscription = subscribeEventStream({ getPort }, handlers);
  subscriptions.push(subscription);
  return subscription;
}

beforeEach(async () => {
  stream = new FakeEventStream();
  await stream.listen();
});

afterEach(async () => {
  activityWatch?.stop();
  notificationsWatch?.stop();
  activityWatch = null;
  notificationsWatch = null;
  // Unsubscribing twice is a no-op, so tests that let go mid-test still land here.
  for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
  // A no-op unless a test installed them; the one that does must not leave them
  // behind for the socket tests that follow it.
  vi.useRealTimers();
  await stream.close();
});

describe('event-stream sharing (DOR-1386)', () => {
  it('serves the tray watcher and the notifications watcher off one HTTP connection, not two', async () => {
    const host = new NoopNotificationHost();
    const counted = deferred();
    const onChange = vi.fn((counts: { streaming: number }) => {
      if (counts.streaming === 1) counted.resolve();
    });

    activityWatch = watchAgentActivity({ getPort: () => stream.port, onChange });
    notificationsWatch = watchNotifications({
      getPort: () => stream.port,
      isWindowUnfocused: () => true,
      focusAndNavigate: vi.fn(),
      host,
    });

    await stream.connectionsReach(1);

    // Both watchers see the same frames off that one connection: a session
    // status reaches the tray watcher, and a notification reaches the
    // notifications watcher, with no second request in between. Asserting on
    // the tray's own callback (rather than a variable neither watcher ever
    // touches) is what makes this fail if the frame never actually reached it.
    stream.sendStatus('session-a', 'streaming');
    await counted.promise;
    expect(onChange).toHaveBeenCalledWith({ streaming: 1, blocked: 0 });

    stream.sendEvent('notification', {
      notification: {
        id: 'notif-1',
        kind: 'turn.completed',
        tier: 'blocking',
        subject: { type: 'session', id: 'session-a' },
        title: 'myproj finished a turn',
        createdAt: '2026-08-19T00:00:00.000Z',
      },
    });
    await host.shows(1);

    expect(stream.connections).toBe(1);
  });

  it('keeps the connection alive for the survivor when one of the two watchers stops', async () => {
    const host = new NoopNotificationHost();
    activityWatch = watchAgentActivity({ getPort: () => stream.port, onChange: vi.fn() });
    notificationsWatch = watchNotifications({
      getPort: () => stream.port,
      isWindowUnfocused: () => true,
      focusAndNavigate: vi.fn(),
      host,
    });
    await stream.connectionsReach(1);

    activityWatch.stop();
    activityWatch = null;

    stream.sendEvent('notification', {
      notification: {
        id: 'notif-2',
        kind: 'turn.completed',
        tier: 'blocking',
        subject: { type: 'session', id: 'session-a' },
        title: 'still here',
        createdAt: '2026-08-19T00:00:00.000Z',
      },
    });
    await host.shows(1);
    // No reconnect was needed for the survivor.
    expect(stream.connections).toBe(1);
  });
});

describe('event-stream teardown (DOR-1730)', () => {
  it('a connection the last unsubscribe tore down cannot reach into the next subscriber', async () => {
    // Node emits ECONNRESET on an in-flight request a tick AFTER `destroy()`
    // returned, so the connection this first subscriber opens calls back once
    // the second subscriber below already has a connection of its own. That
    // late callback used to destroy the second connection and tell its
    // subscriber the stream was lost — which is how `agent-activity.test.ts`
    // came apart, one case reaching its ceiling and the next reading a count
    // that had been cleared out from under it.
    subscribe(() => stream.port, { onFrame: () => {} }).unsubscribe();

    const log = new FrameLog();
    const connectionLost = vi.fn();
    subscribe(() => stream.port, { onFrame: log.record, onConnectionLost: connectionLost });

    await log.arrives('connected');
    stream.sendStatus('session-a', 'streaming');
    await log.arrives('session_status');
    // The survivor's connection is its own: nothing told it the stream was
    // lost, and it never had to come back. One connection reached the server,
    // the survivor's — the first subscriber's request was destroyed before it
    // was even written. Two here is the bug: the survivor being reached into
    // and reconnecting a second later.
    expect(connectionLost).not.toHaveBeenCalled();
    expect(stream.connections).toBe(1);
  });
});

describe('event-stream reconnection (DOR-1727)', () => {
  // These four moved here from `agent-activity.test.ts`, which had been proving
  // the transport's retry loop through the counter that sits on top of it, on a
  // wall clock: two of them were the cases that went red under load. They are
  // this module's contract, so they belong here, and each now ends on a barrier
  // the production code trips rather than on a deadline.

  it('comes back after the stream drops, and delivers on the new connection', async () => {
    const log = new FrameLog();
    const lost = deferred();
    subscribe(() => stream.port, {
      onFrame: log.record,
      onConnectionLost: () => lost.resolve(),
    });

    await log.arrives('connected');

    stream.dropClients();
    await lost.promise;
    await stream.connectionsReach(2);

    // Reconnected is not the same as working, so the proof is a frame sent
    // AFTER the drop arriving on the connection that replaced the one that
    // went away.
    stream.sendStatus('session-a', 'streaming');
    await log.arrives('session_status');
  });

  it('keeps trying when the server refuses the stream, and passes nothing on while it is refused', async () => {
    stream.status = 403;
    const log = new FrameLog();
    subscribe(() => stream.port, { onFrame: log.record });

    // The retry itself is the positive control for the empty log below: the
    // stream is being asked for, repeatedly, and answering 403 to every ask —
    // it is not that nothing is happening.
    await stream.connectionsReach(2);
    expect(log.names).toEqual([]);
  });

  it('waits for a port rather than connecting to nothing', async () => {
    let port: number | null = null;
    subscribe(() => port, { onFrame: () => {} });

    expect(stream.connections).toBe(0);

    port = stream.port;

    // And the moment there IS a port it connects — which is what makes the
    // zero above a fact about the missing port rather than about a
    // subscription that was never going to connect at all.
    await stream.connectionsReach(1);
  });

  it('reassembles an event split across two chunks', async () => {
    const log = new FrameLog();
    subscribe(() => stream.port, { onFrame: log.record });

    await log.arrives('connected');
    const payload = JSON.stringify({
      type: 'session_status',
      sessionId: 'session-a',
      status: { lifecycle: 'streaming' },
    });

    stream.send(`event: session_status\ndata: ${payload.slice(0, 20)}`);
    // A floor, not a ceiling: long enough that the two writes cannot land in
    // one read, and a busy machine only makes it longer — which is the
    // direction that keeps this test honest rather than the one that reds it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.send(`${payload.slice(20)}\n\n`);

    const frame = await log.arrives('session_status');
    expect(frame.data).toBe(payload);
  });

  it('backs off between attempts, and never waits longer than fifteen seconds', () => {
    // The other half of what the wall-clock cases used to assert by accident:
    // that a reconnect is quick. Walked exactly, because how long the module
    // waits is a decision it makes, not a duration to measure — a base delay
    // raised to a minute would have passed every timing bound in this file
    // while making the tray look dead after every server restart.
    expect(RECONNECT_BASE_MS).toBe(1_000);

    const ladder: number[] = [RECONNECT_BASE_MS];
    while (ladder.length < 8) ladder.push(nextReconnectDelayMs(ladder[ladder.length - 1] ?? 0));

    expect(ladder).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000]);
  });

  it('leaves no reconnect armed once the last subscriber lets go', () => {
    // With no port there is no socket in this test at all: the only thing
    // `connect()` can do is arm a retry, which makes the count of armed timers
    // the whole of what there is to observe — and observing it is why the
    // timers are faked here and nowhere else in this file.
    vi.useFakeTimers();

    const subscription = subscribe(() => null, { onFrame: () => {} });
    expect(vi.getTimerCount()).toBe(1);

    subscription.unsubscribe();

    // A retry still armed after the last subscriber has gone is a reconnect
    // nobody asked for, to a port nobody is watching any more. `teardown()`
    // clearing it is what makes an unsubscribe final, and nothing else in this
    // file could tell whether it did.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('event-stream throw isolation (DOR-1386 review)', () => {
  it('a subscriber that throws on a frame does not stop another subscriber, and the throw never escapes as an uncaught exception', async () => {
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);

    const throwingFrames: string[] = [];
    const survivor = new FrameLog();
    subscribe(() => stream.port, {
      onFrame: (frame) => {
        throwingFrames.push(frame.name);
        throw new Error('boom — a malformed payload, or any other subscriber bug');
      },
    });
    subscribe(() => stream.port, { onFrame: survivor.record });

    try {
      await stream.connectionsReach(1);

      stream.sendStatus('session-a', 'streaming');

      await survivor.arrives('session_status');
      // The throwing subscriber ran (and threw) too — it did not silently get
      // skipped, it threw and was caught.
      expect(throwingFrames).toContain('session_status');
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });

  it('a subscriber that throws on connection-lost does not stop another subscriber from being told', async () => {
    const survivorNotified = deferred();
    const notifiedCount = vi.fn(() => survivorNotified.resolve());
    subscribe(() => stream.port, {
      onFrame: () => {},
      onConnectionLost: () => {
        throw new Error('boom');
      },
    });
    subscribe(() => stream.port, { onFrame: () => {}, onConnectionLost: notifiedCount });

    await stream.connectionsReach(1);

    stream.dropClients();

    await survivorNotified.promise;
    expect(notifiedCount).toHaveBeenCalledTimes(1);
  });
});
