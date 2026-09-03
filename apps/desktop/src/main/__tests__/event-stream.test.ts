import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

import { watchAgentActivity, type AgentActivityWatch } from '../agent-activity';
import { watchNotifications, type NotificationsWatch } from '../notifications';
import { subscribeEventStream } from '../event-stream';
import type {
  NativeNotificationHandle,
  NativeNotificationSpec,
  NotificationHost,
} from '../notifications/wrapper';
import { FakeEventStream } from './fake-event-stream';

/** A `NotificationHost` double — this test only cares that a shown count moves, not what's shown. */
class NoopNotificationHost implements NotificationHost {
  shownCount = 0;
  isSupported(): boolean {
    return true;
  }
  show(_spec: NativeNotificationSpec): NativeNotificationHandle {
    this.shownCount += 1;
    return { close: () => {} };
  }
}

let stream: FakeEventStream;
let activityWatch: AgentActivityWatch | null = null;
let notificationsWatch: NotificationsWatch | null = null;

beforeEach(async () => {
  stream = new FakeEventStream();
  await stream.listen();
});

afterEach(async () => {
  activityWatch?.stop();
  notificationsWatch?.stop();
  activityWatch = null;
  notificationsWatch = null;
  await stream.close();
});

describe('event-stream sharing (DOR-1386)', () => {
  it('serves the tray watcher and the notifications watcher off one HTTP connection, not two', async () => {
    const host = new NoopNotificationHost();
    const onChange = vi.fn();

    activityWatch = watchAgentActivity({ getPort: () => stream.port, onChange });
    notificationsWatch = watchNotifications({
      getPort: () => stream.port,
      isWindowUnfocused: () => true,
      focusAndNavigate: vi.fn(),
      host,
    });

    await vi.waitFor(() => expect(stream.connections).toBe(1), { timeout: 2_000, interval: 10 });

    // Both watchers see the same frames off that one connection: a session
    // status reaches the tray watcher, and a notification reaches the
    // notifications watcher, with no second request in between. Asserting on
    // the tray's own callback (rather than a variable neither watcher ever
    // touches) is what makes this fail if the frame never actually reached it.
    stream.sendStatus('session-a', 'streaming');
    await vi.waitFor(
      () => {
        expect(onChange).toHaveBeenCalledWith({ streaming: 1, blocked: 0 });
      },
      { timeout: 2_000, interval: 10 }
    );

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
    await vi.waitFor(() => expect(host.shownCount).toBe(1), { timeout: 2_000, interval: 10 });

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
    await vi.waitFor(() => expect(stream.connections).toBe(1), { timeout: 2_000, interval: 10 });

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
    await vi.waitFor(() => expect(host.shownCount).toBe(1), { timeout: 2_000, interval: 10 });
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
    subscribeEventStream({ getPort: () => stream.port }, { onFrame: () => {} }).unsubscribe();

    const frames: string[] = [];
    const connectionLost = vi.fn();
    const second = subscribeEventStream(
      { getPort: () => stream.port },
      { onFrame: (frame) => frames.push(frame.name), onConnectionLost: connectionLost }
    );

    try {
      await vi.waitFor(() => expect(frames).toContain('connected'), {
        timeout: 2_000,
        interval: 10,
      });
      stream.sendStatus('session-a', 'streaming');
      await vi.waitFor(() => expect(frames).toContain('session_status'), {
        timeout: 2_000,
        interval: 10,
      });
      // The survivor's connection is its own: nothing told it the stream was
      // lost, and it never had to come back. One connection reached the server,
      // the survivor's — the first subscriber's request was destroyed before it
      // was even written. Two here is the bug: the survivor being reached into
      // and reconnecting a second later.
      expect(connectionLost).not.toHaveBeenCalled();
      expect(stream.connections).toBe(1);
    } finally {
      second.unsubscribe();
    }
  });
});

describe('event-stream throw isolation (DOR-1386 review)', () => {
  it('a subscriber that throws on a frame does not stop another subscriber, and the throw never escapes as an uncaught exception', async () => {
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);

    const throwingFrames: string[] = [];
    const survivorFrames: string[] = [];
    const throwing = subscribeEventStream(
      { getPort: () => stream.port },
      {
        onFrame: (frame) => {
          throwingFrames.push(frame.name);
          throw new Error('boom — a malformed payload, or any other subscriber bug');
        },
      }
    );
    const survivor = subscribeEventStream(
      { getPort: () => stream.port },
      { onFrame: (frame) => survivorFrames.push(frame.name) }
    );

    try {
      await vi.waitFor(() => expect(stream.connections).toBe(1), { timeout: 2_000, interval: 10 });

      stream.sendStatus('session-a', 'streaming');

      await vi.waitFor(() => expect(survivorFrames).toContain('session_status'), {
        timeout: 2_000,
        interval: 10,
      });
      // The throwing subscriber ran (and threw) too — it did not silently get
      // skipped, it threw and was caught.
      expect(throwingFrames).toContain('session_status');
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      throwing.unsubscribe();
      survivor.unsubscribe();
      process.off('uncaughtException', uncaught);
    }
  });

  it('a subscriber that throws on connection-lost does not stop another subscriber from being told', async () => {
    const survivorNotified = vi.fn();
    const throwing = subscribeEventStream(
      { getPort: () => stream.port },
      {
        onFrame: () => {},
        onConnectionLost: () => {
          throw new Error('boom');
        },
      }
    );
    const survivor = subscribeEventStream(
      { getPort: () => stream.port },
      { onFrame: () => {}, onConnectionLost: survivorNotified }
    );

    try {
      await vi.waitFor(() => expect(stream.connections).toBe(1), { timeout: 2_000, interval: 10 });

      stream.dropClients();

      await vi.waitFor(() => expect(survivorNotified).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
        interval: 10,
      });
    } finally {
      throwing.unsubscribe();
      survivor.unsubscribe();
    }
  });
});
