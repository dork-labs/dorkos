import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

import { watchNotifications, type NotificationsWatch } from '../index';
import { resetAnswerLogGuard } from '../answer';
import type {
  NativeNotificationHandle,
  NativeNotificationSpec,
  NotificationHost,
} from '../wrapper';
import { FakeEventStream } from '../../__tests__/fake-event-stream';

/** A `NotificationHost` double that records every shown spec and a closeable handle for it. */
class FakeNotificationHost implements NotificationHost {
  supported = true;
  shown: { spec: NativeNotificationSpec; closed: boolean }[] = [];

  isSupported(): boolean {
    return this.supported;
  }

  show(spec: NativeNotificationSpec): NativeNotificationHandle {
    const entry = { spec, closed: false };
    this.shown.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
    };
  }
}

const fetchMock = vi.fn();

let stream: FakeEventStream;
let host: FakeNotificationHost;
let watch: NotificationsWatch | null = null;
let unfocused = true;
const focusAndNavigate = vi.fn<(path: string) => void>();

beforeEach(async () => {
  stream = new FakeEventStream();
  await stream.listen();
  host = new FakeNotificationHost();
  unfocused = true;
  focusAndNavigate.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  resetAnswerLogGuard();
});

afterEach(async () => {
  watch?.stop();
  watch = null;
  await stream.close();
  vi.unstubAllGlobals();
});

/** Start watching the fake stream and wait until it is connected. */
async function start(): Promise<void> {
  watch = watchNotifications({
    getPort: () => stream.port,
    isWindowUnfocused: () => unfocused,
    focusAndNavigate,
    host,
  });
  await stream.connected();
}

/** Wait for a condition the stream (or a fire-and-forget async handler) will satisfy on its own. */
async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 2_000, interval: 10 });
}

function sendAskPending(overrides: {
  sessionId?: string;
  cwd?: string;
  interaction: Record<string, unknown>;
}): void {
  stream.sendEvent('interaction_pending', {
    sessionId: overrides.sessionId ?? 'session-1',
    cwd: overrides.cwd ?? '/Users/dork/projects/myproj',
    interaction: overrides.interaction,
  });
}

function approval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'approval',
    id: 'tool-1',
    startedAt: 0,
    remainingMs: 60_000,
    toolName: 'Bash',
    input: 'rm -rf /',
    hasSuggestions: false,
    ...overrides,
  };
}

function singleQuestion(question = 'What color should the button be?'): Record<string, unknown> {
  return {
    type: 'question',
    id: 'question-1',
    startedAt: 0,
    remainingMs: 60_000,
    questions: [{ header: 'Color', question, options: [], multiSelect: false }],
  };
}

function sendNotification(overrides: Record<string, unknown> = {}): void {
  stream.sendEvent('notification', {
    notification: {
      id: 'notif-1',
      kind: 'turn.completed',
      tier: 'notable',
      subject: { type: 'session', id: 'session-1' },
      sessionId: 'session-1',
      title: 'myproj finished a turn',
      createdAt: '2026-08-19T00:00:00.000Z',
      ...overrides,
    },
  });
}

describe('watchNotifications — Asks', () => {
  it('shows a Blocking banner for a pending approval, with Allow/Deny actions', async () => {
    await start();
    sendAskPending({ interaction: approval() });

    await eventually(() => expect(host.shown).toHaveLength(1));
    expect(host.shown[0]?.spec.title).toBe('myproj is waiting on your answer');
    expect(host.shown[0]?.spec.actions).toEqual([{ label: 'Allow' }, { label: 'Deny' }]);
  });

  it('shows a Blocking banner even while a window is focused — Blocking always interrupts', async () => {
    unfocused = false;
    await start();
    sendAskPending({ interaction: approval() });

    await eventually(() => expect(host.shown).toHaveLength(1));
  });

  it('never shows the same pending Ask twice', async () => {
    await start();
    sendAskPending({ interaction: approval() });
    await eventually(() => expect(host.shown).toHaveLength(1));

    sendAskPending({ interaction: approval() });
    // Give the (absent) second show a chance to land before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.shown).toHaveLength(1);
  });

  it('Allow POSTs the exact approve payload', async () => {
    await start();
    sendAskPending({ sessionId: 'session-9', interaction: approval({ id: 'tool-9' }) });
    await eventually(() => expect(host.shown).toHaveLength(1));

    host.shown[0]?.spec.onAction?.(0);

    await eventually(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:' + stream.port + '/api/sessions/session-9/approve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId: 'tool-9' }),
      }
    );
  });

  it('Deny POSTs the exact deny payload', async () => {
    await start();
    sendAskPending({ sessionId: 'session-9', interaction: approval({ id: 'tool-9' }) });
    await eventually(() => expect(host.shown).toHaveLength(1));

    host.shown[0]?.spec.onAction?.(1);

    await eventually(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:' + stream.port + '/api/sessions/session-9/deny',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId: 'tool-9' }),
      }
    );
  });

  it('offers a reply field for a single-question ask, and Reply POSTs the typed text as answer 0', async () => {
    await start();
    sendAskPending({ sessionId: 'session-9', interaction: singleQuestion('Pick a color') });
    await eventually(() => expect(host.shown).toHaveLength(1));

    expect(host.shown[0]?.spec.hasReply).toBe(true);
    expect(host.shown[0]?.spec.replyPlaceholder).toBe('Pick a color');
    expect(host.shown[0]?.spec.actions).toBeUndefined();

    host.shown[0]?.spec.onReply?.('Blue, please');

    await eventually(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:' + stream.port + '/api/sessions/session-9/submit-answers',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId: 'question-1', answers: { '0': 'Blue, please' } }),
      }
    );
  });

  it('offers neither actions nor a reply for a multi-question ask', async () => {
    await start();
    sendAskPending({
      interaction: {
        type: 'question',
        id: 'question-2',
        startedAt: 0,
        remainingMs: 60_000,
        questions: [
          { header: 'Color', question: 'What color?', options: [], multiSelect: false },
          { header: 'Size', question: 'What size?', options: [], multiSelect: false },
        ],
      },
    });
    await eventually(() => expect(host.shown).toHaveLength(1));
    expect(host.shown[0]?.spec.hasReply).toBeUndefined();
    expect(host.shown[0]?.spec.actions).toBeUndefined();
  });

  it('clicking the banner focuses the window and deep-links to the session', async () => {
    await start();
    sendAskPending({ sessionId: 'session-9', interaction: approval() });
    await eventually(() => expect(host.shown).toHaveLength(1));

    host.shown[0]?.spec.onClick?.();

    expect(focusAndNavigate).toHaveBeenCalledWith('/session?session=session-9');
  });

  it('closes the banner when interaction_resolved names it', async () => {
    await start();
    sendAskPending({ interaction: approval({ id: 'tool-close-me' }) });
    await eventually(() => expect(host.shown).toHaveLength(1));

    stream.sendEvent('interaction_resolved', {
      sessionId: 'session-1',
      interactionId: 'tool-close-me',
      outcome: 'answered',
      resolvedAt: '2026-08-19T00:00:00.000Z',
    });

    await eventually(() => expect(host.shown[0]?.closed).toBe(true));
  });

  it('falls back to focus+deep-link on 401 (remote login on, main holds no credential)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await start();
    sendAskPending({ sessionId: 'session-9', interaction: approval() });
    await eventually(() => expect(host.shown).toHaveLength(1));

    host.shown[0]?.spec.onAction?.(0);

    await eventually(() =>
      expect(focusAndNavigate).toHaveBeenCalledWith('/session?session=session-9')
    );
  });

  it('does NOT steal focus on a refused action — the server understood and said no (already resolved)', async () => {
    // 409 INTERACTION_ALREADY_RESOLVED — someone else already answered it, or
    // it timed out. Reopening the app over a card that no longer exists would
    // surprise the person for nothing.
    fetchMock.mockResolvedValue(new Response(null, { status: 409 }));
    await start();
    sendAskPending({ sessionId: 'session-9', interaction: approval() });
    await eventually(() => expect(host.shown).toHaveLength(1));

    host.shown[0]?.spec.onAction?.(0);

    await eventually(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Give the (absent) fallback a chance to land before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(focusAndNavigate).not.toHaveBeenCalled();
  });

  it('does NOT steal focus on a refused reply either', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 409 }));
    await start();
    sendAskPending({ sessionId: 'session-9', interaction: singleQuestion() });
    await eventually(() => expect(host.shown).toHaveLength(1));

    host.shown[0]?.spec.onReply?.('Blue');

    await eventually(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(focusAndNavigate).not.toHaveBeenCalled();
  });

  it('shows nothing for a question-type interaction whose questions field is not an array', async () => {
    await start();
    sendAskPending({
      interaction: {
        type: 'question',
        id: 'question-malformed',
        startedAt: 0,
        remainingMs: 60_000,
        questions: 'not-an-array',
      },
    });
    // Give the (absent) banner a chance to land before asserting it didn't —
    // and prove the malformed payload didn't crash the watcher either: a
    // well-formed frame right after it still gets through.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.shown).toHaveLength(0);

    sendAskPending({ interaction: approval() });
    await eventually(() => expect(host.shown).toHaveLength(1));
  });
});

describe('watchNotifications — Activity notifications', () => {
  it('shows a Notable notification only while no window is focused', async () => {
    unfocused = false;
    await start();
    sendNotification({ tier: 'notable' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.shown).toHaveLength(0);
  });

  it('shows a Notable notification once no window is focused', async () => {
    unfocused = true;
    await start();
    sendNotification({ tier: 'notable' });
    await eventually(() => expect(host.shown).toHaveLength(1));
  });

  it('shows a Blocking notification regardless of focus', async () => {
    unfocused = false;
    await start();
    sendNotification({ id: 'notif-blocking', tier: 'blocking' });
    await eventually(() => expect(host.shown).toHaveLength(1));
  });

  it('never shows a Quiet notification', async () => {
    unfocused = true;
    await start();
    sendNotification({ id: 'notif-quiet', tier: 'quiet' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.shown).toHaveLength(0);
  });

  it("skips a notification that arrives already read — a person's own action, or already handled", async () => {
    unfocused = true;
    await start();
    sendNotification({ id: 'notif-read', tier: 'blocking', readAt: '2026-08-19T00:00:01.000Z' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.shown).toHaveLength(0);
  });

  it('never shows the same notification id twice', async () => {
    unfocused = true;
    await start();
    sendNotification({ id: 'notif-dupe', tier: 'blocking' });
    await eventually(() => expect(host.shown).toHaveLength(1));

    sendNotification({ id: 'notif-dupe', tier: 'blocking' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.shown).toHaveLength(1);
  });

  it('ignores a notification whose subject type it does not know', async () => {
    // `notificationDeepLink` switches on `subject.type`; a value outside the
    // enum falls off the end of that switch and yields `undefined`, which is a
    // banner whose click goes nowhere. Failing closed is the honest answer —
    // the row is still in the Inbox.
    unfocused = true;
    await start();
    sendNotification({
      id: 'notif-alien',
      tier: 'blocking',
      subject: { type: 'workspace', id: 'ws-1' },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.shown).toHaveLength(0);
  });

  it('ignores a notification whose subject carries no type at all', async () => {
    unfocused = true;
    await start();
    sendNotification({ id: 'notif-typeless', tier: 'blocking', subject: { id: 'x' } });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.shown).toHaveLength(0);
  });

  it('still shows every subject type the deep-link builder handles', async () => {
    // The guard above must fail closed on the unknown, not on everything.
    unfocused = true;
    await start();
    for (const type of ['session', 'task', 'run', 'room', 'agent', 'system']) {
      sendNotification({ id: `notif-${type}`, tier: 'blocking', subject: { type, id: 'x' } });
    }

    await eventually(() => expect(host.shown).toHaveLength(6));
  });

  it("clicking the banner deep-links to the notification's subject", async () => {
    unfocused = true;
    await start();
    sendNotification({ id: 'notif-click', tier: 'blocking', sessionId: 'session-77' });
    await eventually(() => expect(host.shown).toHaveLength(1));

    host.shown[0]?.spec.onClick?.();
    expect(focusAndNavigate).toHaveBeenCalledWith('/session?session=session-77');
  });

  it('closes a tracked banner when notification_read names its id', async () => {
    unfocused = true;
    await start();
    sendNotification({ id: 'notif-read-me', tier: 'blocking' });
    await eventually(() => expect(host.shown).toHaveLength(1));

    stream.sendEvent('notification_read', {
      ids: ['notif-read-me'],
      all: false,
      readAt: '2026-08-19T00:00:02.000Z',
      unreadCount: 0,
    });

    await eventually(() => expect(host.shown[0]?.closed).toBe(true));
  });

  it('closes every tracked banner when notification_read says all', async () => {
    unfocused = true;
    await start();
    sendNotification({ id: 'notif-a', tier: 'blocking' });
    sendNotification({ id: 'notif-b', tier: 'blocking' });
    await eventually(() => expect(host.shown).toHaveLength(2));

    stream.sendEvent('notification_read', {
      ids: [],
      all: true,
      readAt: '2026-08-19T00:00:03.000Z',
      unreadCount: 0,
    });

    await eventually(() => expect(host.shown.every((entry) => entry.closed)).toBe(true));
  });
});

describe('watchNotifications — platform support', () => {
  it('does nothing on a platform that cannot show native notifications', () => {
    host.supported = false;
    // Deliberately not `start()`: an unsupported platform never subscribes to
    // the stream at all, so there is no connection to wait for — that IS the
    // no-op this test is proving.
    watch = watchNotifications({
      getPort: () => stream.port,
      isWindowUnfocused: () => unfocused,
      focusAndNavigate,
      host,
    });
    expect(stream.connections).toBe(0);
    expect(host.shown).toHaveLength(0);
  });
});
