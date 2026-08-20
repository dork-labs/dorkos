import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

import { watchAgentActivity, type AgentActivityWatch } from '../agent-activity';
import { watchNotifications, type NotificationsWatch } from '../notifications';
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

    activityWatch = watchAgentActivity({ getPort: () => stream.port, onChange: vi.fn() });
    notificationsWatch = watchNotifications({
      getPort: () => stream.port,
      isWindowUnfocused: () => true,
      focusAndNavigate: vi.fn(),
      host,
    });

    await vi.waitFor(() => expect(stream.connections).toBe(1), { timeout: 2_000, interval: 10 });

    // Both watchers see the same frames off that one connection: a session
    // status reaches the tray watcher, and a notification reaches the
    // notifications watcher, with no second request in between.
    stream.sendStatus('session-a', 'streaming');
    await vi.waitFor(
      () => {
        expect(activityWatch).not.toBeNull();
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
