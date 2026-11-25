import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

/**
 * Where the frames come from, for this file only.
 *
 * `notifications/index.ts` reads the stream through `subscribeEventStream`, so
 * that one call is the seam: with a stand-in behind it a test hands the bridge
 * frames directly and every assertion is true the instant the call returns —
 * nothing to poll, nothing to out-wait. `null` puts the real transport back for
 * the single socket test at the bottom of the file.
 *
 * Everything else `event-stream.ts` exports (`parseEventPayload`, which every
 * parser in the module under test runs its payload through) stays real: this
 * fakes where the frames arrive from, never what they mean.
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

vi.mock('../../event-stream', async (importActual) => {
  const actual = await importActual<typeof import('../../event-stream')>();
  return {
    ...actual,
    subscribeEventStream: (
      options: Parameters<typeof actual.subscribeEventStream>[0],
      handlers: Parameters<typeof actual.subscribeEventStream>[1]
    ) => (seam.subscribe ?? actual.subscribeEventStream)(options, handlers),
  };
});

import { watchNotifications, type NotificationsWatch } from '../index';
import { resetAnswerLogGuard } from '../answer';
import type {
  NativeNotificationHandle,
  NativeNotificationSpec,
  NotificationHost,
} from '../wrapper';
import { FakeEventSource, FakeEventStream } from '../../__tests__/fake-event-stream';

/** The port the bridge is told the server is on — a constant, since nothing here opens a socket. */
const PORT = 4242;

/**
 * A `NotificationHost` double that records every shown spec and a closeable
 * handle for it.
 *
 * {@link shows} is the barrier the one socket test waits on; every other test
 * in this file is handed its frames synchronously and has nothing to wait for.
 */
class FakeNotificationHost implements NotificationHost {
  supported = true;
  readonly shown: { spec: NativeNotificationSpec; closed: boolean; closes: number }[] = [];
  private waiters: { at: number; resolve: () => void }[] = [];

  isSupported(): boolean {
    return this.supported;
  }

  show(spec: NativeNotificationSpec): NativeNotificationHandle {
    const entry = { spec, closed: false, closes: 0 };
    this.shown.push(entry);
    const reached = this.waiters.filter((waiter) => waiter.at <= this.shown.length);
    this.waiters = this.waiters.filter((waiter) => waiter.at > this.shown.length);
    for (const waiter of reached) waiter.resolve();
    return {
      close: () => {
        entry.closed = true;
        // Counted, not just flagged: a banner retired twice — once by its
        // expiry timer and once by the resolution that beat it — is invisible
        // to a boolean.
        entry.closes += 1;
      },
    };
  }

  /**
   * Resolve once `count` banners have been shown in total (immediately if they have).
   *
   * @param count - The running total to wait for.
   */
  async shows(count: number): Promise<void> {
    if (this.shown.length >= count) return;
    await new Promise<void>((resolve) => this.waiters.push({ at: count, resolve }));
  }
}

const fetchMock = vi.fn();

let source: FakeEventSource;
let host: FakeNotificationHost;
let watch: NotificationsWatch | null = null;
let unfocused = true;
const focusAndNavigate = vi.fn<(path: string) => void>();
/** The real HTTP stream, for the one test at the bottom that opens one. */
let socket: FakeEventStream | null = null;

beforeEach(() => {
  source = new FakeEventSource();
  seam.subscribe = source.subscribe;
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
  seam.subscribe = null;
  // A no-op unless a test installed them; the one that does must not leave them
  // behind for whatever runs next.
  vi.useRealTimers();
  // Cleaning up here rather than in the socket test's own `finally` is what
  // keeps a test that never settles from leaving a live server (and a live
  // subscription to it) behind: a `finally` inside a hung test never runs, and
  // `afterEach` runs regardless.
  await socket?.close();
  socket = null;
  vi.unstubAllGlobals();
});

/** Start watching the fake source. Nothing to wait for — the seam is already connected. */
function start(): void {
  watch = watchNotifications({
    getPort: () => PORT,
    isWindowUnfocused: () => unfocused,
    focusAndNavigate,
    host,
  });
}

/**
 * Let the fire-and-forget answer chain a banner click starts run to its end.
 *
 * `onAction` and `onReply` hand `void`-ed promises to Electron, so the part of
 * the chain a test cannot await is everything after `fetch` resolves — and all
 * of that is microtasks, which the runtime drains to empty before it runs the
 * next macrotask. So one turn of the event loop is past all of it, whatever
 * else the machine is doing: a turn, not a slice of the wall clock, with no
 * budget for a busy machine to spend (DOR-1826). `fetch` itself is called
 * synchronously inside the click, so nothing has to wait for that at all.
 */
function answerSettles(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function sendAskPending(overrides: {
  sessionId?: string;
  cwd?: string;
  interaction: Record<string, unknown>;
}): void {
  source.emitEvent('interaction_pending', {
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

function notificationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
}

function sendNotification(overrides: Record<string, unknown> = {}): void {
  source.emitEvent('notification', notificationPayload(overrides));
}

function sendStandingPending(overrides: Record<string, unknown> = {}): void {
  source.emitEvent('standing_pending', {
    kind: 'schedule.parked',
    subjectKey: 'schedule:task-1',
    tier: 'blocking',
    title: 'Nightly Bot proposed a scheduled task',
    body: 'nightly-sweep will not run until you approve it.',
    deepLink: '/tasks',
    since: '2026-08-25T00:00:00.000Z',
    ...overrides,
  });
}

/**
 * The two standing conditions that reach the desktop app only through this
 * event (DOR-1570).
 *
 * Before it existed the shell showed NOTHING for either: a schedule an agent
 * proposed and an approval it needed for something irreversible are both
 * standing kinds, which store no row while they stand, so nothing was ever
 * broadcast on the `notification` channel to pop a banner from. The operator
 * had to ask an agent to open the Tasks panel to find out.
 */
describe('watchNotifications — standing conditions', () => {
  it('shows a banner for a schedule an agent proposed', () => {
    start();
    sendStandingPending();

    expect(host.shown).toHaveLength(1);
    expect(host.shown[0]?.spec.title).toBe('Nightly Bot proposed a scheduled task');
    expect(host.shown[0]?.spec.body).toBe('nightly-sweep will not run until you approve it.');
    // Click-to-open, no buttons: a schedule that will run unattended, and an
    // irreversible action, both deserve the card in front of you.
    expect(host.shown[0]?.spec.actions).toBeUndefined();
    expect(host.shown[0]?.spec.hasReply).toBeUndefined();
  });

  it('opens the route the server chose when the banner is clicked', () => {
    start();
    sendStandingPending({ kind: 'approval.pending', subjectKey: 'approval:01J1', deepLink: '/' });

    host.shown[0]?.spec.onClick?.();

    expect(focusAndNavigate).toHaveBeenCalledWith('/');
  });

  it('never shows the same condition twice', () => {
    start();
    sendStandingPending();
    expect(host.shown).toHaveLength(1);

    sendStandingPending();

    expect(host.shown).toHaveLength(1);
    // Positive control for that did-not-happen: the de-dupe is on the subject
    // key, not on the stream having gone quiet — a DIFFERENT condition still
    // gets its banner.
    sendStandingPending({ subjectKey: 'schedule:task-2' });
    expect(host.shown).toHaveLength(2);
  });

  it('closes the banner when the condition resolves', () => {
    start();
    sendStandingPending();
    expect(host.shown).toHaveLength(1);

    source.emitEvent('standing_resolved', {
      kind: 'schedule.parked',
      subjectKey: 'schedule:task-1',
      resolvedAt: '2026-08-25T00:01:00.000Z',
    });

    expect(host.shown[0]?.closed).toBe(true);
    // And the condition is forgotten, not merely closed: a standing kind's
    // `dedupeKey` is stable for the life of its subject (`schedule:${taskId}`,
    // `notification-registry.ts`), so the very same key stands again whenever
    // the task goes back to pending_approval. A resolution that closed the
    // banner without dropping the key would silently suppress every later
    // raise of it.
    sendStandingPending();
    expect(host.shown).toHaveLength(2);
  });

  // Expiry is the one ending the server never announces (DOR-1570 review): an
  // approval that runs out of time with no agent retry and no operator click
  // produces no `standing_resolved`. Without a local timer the banner would
  // linger forever, deep-linking to a bell with nothing behind it.
  //
  // The three cases below are the only ones in this file that involve a clock
  // at all, and they own it rather than race it: with timers faked, the
  // deadline arrives exactly when the test says so.
  it('retires an approval banner at its own expiry, with no standing_resolved', () => {
    vi.useFakeTimers();
    start();
    sendStandingPending({
      kind: 'approval.pending',
      subjectKey: 'approval:01JEXPIRE',
      title: 'Nightly Bot needs your approval',
      deepLink: '/',
      expiresAt: new Date(Date.now() + 40).toISOString(),
    });
    expect(host.shown).toHaveLength(1);
    expect(host.shown[0]?.closed).toBe(false);

    // The bridge adds ~500ms of slack so its timer fires strictly after the
    // deadline the server enforces; nothing else is sent.
    vi.advanceTimersByTime(1_000);

    expect(host.shown[0]?.closed).toBe(true);
  });
});

describe('watchNotifications — Asks', () => {
  it('shows a Blocking banner for a pending approval, with Allow/Deny actions', () => {
    start();
    sendAskPending({ interaction: approval() });

    expect(host.shown).toHaveLength(1);
    expect(host.shown[0]?.spec.title).toBe('myproj is waiting on your answer');
    expect(host.shown[0]?.spec.actions).toEqual([{ label: 'Allow' }, { label: 'Deny' }]);
  });

  it('Allow POSTs the exact approve payload', () => {
    start();
    sendAskPending({ sessionId: 'session-9', interaction: approval({ id: 'tool-9' }) });

    host.shown[0]?.spec.onAction?.(0);

    // The request goes out synchronously inside the click, before the chain
    // that reads its answer ever suspends.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:${PORT}/api/sessions/session-9/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId: 'tool-9' }),
      }
    );
  });

  it('Deny POSTs the exact deny payload', () => {
    start();
    sendAskPending({ sessionId: 'session-9', interaction: approval({ id: 'tool-9' }) });

    host.shown[0]?.spec.onAction?.(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`http://localhost:${PORT}/api/sessions/session-9/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tool-9' }),
    });
  });

  it('offers a reply field for a single-question ask, and Reply POSTs the typed text as answer 0', () => {
    start();
    sendAskPending({ sessionId: 'session-9', interaction: singleQuestion('Pick a color') });

    expect(host.shown[0]?.spec.hasReply).toBe(true);
    expect(host.shown[0]?.spec.replyPlaceholder).toBe('Pick a color');
    expect(host.shown[0]?.spec.actions).toBeUndefined();

    host.shown[0]?.spec.onReply?.('Blue, please');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:${PORT}/api/sessions/session-9/submit-answers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId: 'question-1', answers: { '0': 'Blue, please' } }),
      }
    );
  });

  it('closes the banner when interaction_resolved names it', () => {
    start();
    sendAskPending({ interaction: approval({ id: 'tool-close-me' }) });
    expect(host.shown).toHaveLength(1);

    source.emitEvent('interaction_resolved', {
      sessionId: 'session-1',
      interactionId: 'tool-close-me',
      outcome: 'answered',
      resolvedAt: '2026-08-19T00:00:00.000Z',
    });

    expect(host.shown[0]?.closed).toBe(true);
  });

  it('falls back to focus+deep-link on 401 (remote login on, main holds no credential)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    start();
    sendAskPending({ sessionId: 'session-9', interaction: approval() });

    host.shown[0]?.spec.onAction?.(0);

    await answerSettles();
    expect(focusAndNavigate).toHaveBeenCalledWith('/session?session=session-9');
  });

  it('does NOT steal focus on a refused action — the server understood and said no (already resolved)', async () => {
    // 409 already_resolved — someone else already answered it, or
    // it timed out. Reopening the app over a card that no longer exists would
    // surprise the person for nothing.
    fetchMock.mockResolvedValue(new Response(null, { status: 409 }));
    start();
    sendAskPending({ sessionId: 'session-9', interaction: approval() });

    host.shown[0]?.spec.onAction?.(0);

    await answerSettles();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(focusAndNavigate).not.toHaveBeenCalled();

    // Positive control: the same click on the same banner DOES steal focus when
    // the server answers a reason that a reopened window can help with. So the
    // silence above was the 409 being read as final, not a chain that never ran.
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    host.shown[0]?.spec.onAction?.(0);
    await answerSettles();
    expect(focusAndNavigate).toHaveBeenCalledWith('/session?session=session-9');
  });
});

describe('watchNotifications — Activity notifications', () => {
  it('shows a Notable notification only while no window is focused', () => {
    unfocused = false;
    start();
    sendNotification({ tier: 'notable' });

    expect(host.shown).toHaveLength(0);
    // Positive control: a Blocking row on the same focused window does show, so
    // the silence was the tier rule and not a stream nobody is listening to.
    sendNotification({ id: 'notif-blocking', tier: 'blocking' });
    expect(host.shown).toHaveLength(1);
  });

  it('shows a Blocking notification regardless of focus', () => {
    unfocused = false;
    start();
    sendNotification({ id: 'notif-blocking', tier: 'blocking' });

    expect(host.shown).toHaveLength(1);
  });

  it('never shows a Quiet notification', () => {
    unfocused = true;
    start();
    sendNotification({ id: 'notif-quiet', tier: 'quiet' });

    expect(host.shown).toHaveLength(0);
    sendNotification({ id: 'notif-loud', tier: 'blocking' });
    expect(host.shown).toHaveLength(1);
  });

  it("skips a notification that arrives already read — a person's own action, or already handled", () => {
    unfocused = true;
    start();
    sendNotification({ id: 'notif-read', tier: 'blocking', readAt: '2026-08-19T00:00:01.000Z' });

    expect(host.shown).toHaveLength(0);
    // Positive control: the same row without `readAt` shows.
    sendNotification({ id: 'notif-unread', tier: 'blocking' });
    expect(host.shown).toHaveLength(1);
  });

  it("clicking the banner deep-links to the notification's subject", () => {
    unfocused = true;
    start();
    sendNotification({ id: 'notif-click', tier: 'blocking', sessionId: 'session-77' });

    host.shown[0]?.spec.onClick?.();

    expect(focusAndNavigate).toHaveBeenCalledWith('/session?session=session-77');
  });

  it('closes a tracked banner when notification_read names its id', () => {
    unfocused = true;
    start();
    sendNotification({ id: 'notif-read-me', tier: 'blocking' });
    expect(host.shown).toHaveLength(1);

    source.emitEvent('notification_read', {
      ids: ['notif-read-me'],
      all: false,
      readAt: '2026-08-19T00:00:02.000Z',
      unreadCount: 0,
    });

    expect(host.shown[0]?.closed).toBe(true);
  });
});

describe('watchNotifications — platform support', () => {
  it('does nothing on a platform that cannot show native notifications', () => {
    host.supported = false;

    start();

    // An unsupported platform never subscribes to the stream at all — that IS
    // the no-op this test is proving.
    expect(source.subscriptions).toHaveLength(0);
    sendNotification({ tier: 'blocking' });
    expect(host.shown).toHaveLength(0);

    // Positive control: the very same call on a supported host does subscribe,
    // so the zero above is the platform check and not a watcher that never
    // subscribes to anything.
    watch?.stop();
    host.supported = true;
    start();
    expect(source.subscriptions).toHaveLength(1);
  });
});

describe('watchNotifications over a real socket', () => {
  /**
   * The one test in this file that opens a socket, and the only reason the rest
   * can be trusted: it proves the seam above is wired to something real — a
   * `notification` frame written to a real SSE response, over a real TCP
   * connection, through the real `event-stream.ts`, pops a real banner.
   *
   * It waits on barriers the production code trips (the server's own request
   * handler; the host's own `show`), never on a deadline, so there is no budget
   * for a loaded machine to spend. The package's `testTimeout` still bounds a
   * genuine hang. If it ever does flake, DELETE it rather than raising
   * anything — every behaviour it touches is asserted exactly above, and a
   * socket test that has to be nursed is worth less than the noise it makes
   * (DOR-1777).
   */
  it('shows a banner off a real SSE connection', async () => {
    seam.subscribe = null;
    // Handed to `afterEach` before anything can throw, so the server is closed
    // even if this test never reaches its end.
    const stream = new FakeEventStream();
    socket = stream;
    await stream.listen();

    watch = watchNotifications({
      getPort: () => stream.port,
      isWindowUnfocused: () => true,
      focusAndNavigate,
      host,
    });
    await stream.connected();

    stream.sendEvent('notification', notificationPayload({ tier: 'blocking' }));

    await host.shows(1);
    expect(host.shown[0]?.spec.title).toBe('myproj finished a turn');
  });
});
