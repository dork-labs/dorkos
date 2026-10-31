import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encodeStreamFrame,
  STREAM_CLOSE_CODE_BASE,
  STREAM_HEARTBEAT_EVENT,
  STREAM_RESUME_PARAM,
} from '@dorkos/shared/stream-socket';

import { WSConnection, StreamRefusedError, toStreamSocketUrl } from '../ws-connection';

/**
 * WSConnection tests.
 *
 * The resilience contract is the one the SSE connection had — same states, same
 * full-jitter backoff, same silence watchdog — because `StreamManager` above it
 * did not change. What is genuinely new, and therefore what these lean on, is
 * the cursor moving from a header into the URL and liveness becoming a frame
 * rather than an SSE comment.
 */

/** A scriptable stand-in for the browser `WebSocket`. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** Drive the handshake completing. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver one server frame. */
  deliver(frame: { event: string; data?: unknown; id?: string }): void {
    this.onmessage?.({ data: encodeStreamFrame(frame) } as MessageEvent<unknown>);
  }

  /** Drive the socket dropping the way a lost connection does (no close frame). */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' } as CloseEvent);
  }

  /** Drive the server refusing this stream with an application close code. */
  refuse(status: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code: STREAM_CLOSE_CODE_BASE + status, reason } as CloseEvent);
  }
}

const TEST_URL = '/api/sessions/abc/events?cwd=%2Fwork';

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The most recently constructed fake socket. */
const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]!;

describe('toStreamSocketUrl', () => {
  it('maps a page-relative URL onto the page origin as ws:', () => {
    // jsdom serves the page over http://localhost:3000 by default.
    expect(toStreamSocketUrl('/api/events')).toBe('ws://localhost:3000/api/events');
  });

  it('maps an absolute https URL to wss:, keeping its host', () => {
    // Packaged Electron: the renderer origin is file://, so the stream URL is
    // absolute and its host must survive.
    expect(toStreamSocketUrl('https://example.test:8443/api/events')).toBe(
      'wss://example.test:8443/api/events'
    );
  });

  it('preserves existing query params and adds the resume cursor', () => {
    const url = new URL(toStreamSocketUrl(TEST_URL, 'abc-123-7'));
    expect(url.searchParams.get('cwd')).toBe('/work');
    expect(url.searchParams.get(STREAM_RESUME_PARAM)).toBe('abc-123-7');
  });

  it('omits the resume cursor entirely on a cold connect', () => {
    const url = new URL(toStreamSocketUrl(TEST_URL));
    expect(url.searchParams.has(STREAM_RESUME_PARAM)).toBe(false);
  });
});

describe('WSConnection', () => {
  it('dispatches a frame to the handler registered for its event name', () => {
    const onTextDelta = vi.fn();
    const conn = new WSConnection(TEST_URL, { eventHandlers: { text_delta: onTextDelta } });
    conn.connect();
    latest().open();

    latest().deliver({ event: 'text_delta', data: { seq: 1, text: 'hi' } });

    expect(onTextDelta).toHaveBeenCalledWith({ seq: 1, text: 'hi' });
    conn.destroy();
  });

  it('reports connected once the handshake completes', () => {
    const onStateChange = vi.fn();
    const conn = new WSConnection(TEST_URL, { eventHandlers: {}, onStateChange });
    conn.connect();
    // No `connecting` callback on the FIRST connect: that is already the
    // starting state and `setState` only fires on a change. Matches the SSE
    // connection this replaced, and `getState()` reports it either way.
    expect(conn.getState()).toBe('connecting');

    latest().open();

    expect(onStateChange).toHaveBeenCalledWith('connected', 0);
    conn.destroy();
  });

  it('RESUMES from the last frame id it saw, in the query string', () => {
    // The cursor cannot ride a header — a browser `WebSocket` takes only a URL —
    // so losing it here would silently re-hydrate from scratch on every drop.
    const conn = new WSConnection(TEST_URL, { eventHandlers: { text_delta: vi.fn() } });
    conn.connect();
    latest().open();
    latest().deliver({ event: 'text_delta', data: {}, id: 'abc-999-42' });

    latest().drop();
    vi.advanceTimersByTime(60_000);

    const reconnected = new URL(latest().url);
    expect(reconnected.searchParams.get(STREAM_RESUME_PARAM)).toBe('abc-999-42');
    expect(reconnected.searchParams.get('cwd'), 'the original query survives').toBe('/work');
    conn.destroy();
  });

  // The event name comes off the wire, and the handler map is a plain object,
  // so an unguarded `handlers[frame.event]` reaches everything Object.prototype
  // carries. Only a handler this client registered itself may ever be called.
  it('never calls anything the handler map merely inherits', () => {
    const inherited = vi.fn();
    const handlers = Object.create({ text_delta: inherited }) as Record<
      string,
      (data: unknown) => void
    >;
    const conn = new WSConnection(TEST_URL, { eventHandlers: handlers });
    conn.connect();
    latest().open();

    latest().deliver({ event: 'text_delta', data: { text: 'hi' } });

    expect(inherited).not.toHaveBeenCalled();
    conn.destroy();
  });

  it('ignores a frame naming a built-in member of the handler map', () => {
    const conn = new WSConnection(TEST_URL, { eventHandlers: {} });
    conn.connect();
    latest().open();

    expect(() => {
      latest().deliver({ event: 'constructor', data: { text: 'hi' } });
      latest().deliver({ event: 'toString', data: { text: 'hi' } });
      latest().deliver({ event: '__proto__', data: { text: 'hi' } });
    }).not.toThrow();

    conn.destroy();
  });

  it('ignores a handler slot holding something that is not a function', () => {
    const handlers = { text_delta: 'not a function' } as unknown as Record<
      string,
      (data: unknown) => void
    >;
    const conn = new WSConnection(TEST_URL, { eventHandlers: handlers });
    conn.connect();
    latest().open();

    expect(() => latest().deliver({ event: 'text_delta', data: {} })).not.toThrow();

    conn.destroy();
  });

  it('retains a frame id even when no handler is registered for its event', () => {
    // The id IS the cursor. Dropping one because nothing listened to that event
    // would replay it on the next reconnect.
    const conn = new WSConnection(TEST_URL, { eventHandlers: {} });
    conn.connect();
    latest().open();
    latest().deliver({ event: 'nobody_listens', data: {}, id: 'abc-999-7' });

    latest().drop();
    vi.advanceTimersByTime(60_000);

    expect(new URL(latest().url).searchParams.get(STREAM_RESUME_PARAM)).toBe('abc-999-7');
    conn.destroy();
  });

  it('treats a heartbeat as proof of life but never dispatches it', () => {
    const handler = vi.fn();
    const conn = new WSConnection(TEST_URL, {
      eventHandlers: { [STREAM_HEARTBEAT_EVENT]: handler },
      heartbeatTimeoutMs: 1000,
    });
    conn.connect();
    latest().open();

    // Past the watchdog if nothing counted; heartbeats keep resetting it.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(800);
      latest().deliver({ event: STREAM_HEARTBEAT_EVENT });
    }

    expect(handler, 'the reserved name is consumed, not delivered').not.toHaveBeenCalled();
    expect(latest().closed, 'the socket was never treated as dead').toBe(false);
    conn.destroy();
  });

  it('reconnects when the socket goes silent past the watchdog', () => {
    // A half-open socket — a slept laptop's — never fires close, so silence is
    // the only signal there is.
    const conn = new WSConnection(TEST_URL, { eventHandlers: {}, heartbeatTimeoutMs: 1000 });
    conn.connect();
    latest().open();
    const before = FakeSocket.instances.length;

    vi.advanceTimersByTime(1001); // watchdog fires
    vi.advanceTimersByTime(60_000); // backoff elapses

    expect(FakeSocket.instances.length).toBeGreaterThan(before);
    conn.destroy();
  });

  it('reports disconnected after the failure threshold', () => {
    const onStateChange = vi.fn();
    const conn = new WSConnection(TEST_URL, {
      eventHandlers: {},
      onStateChange,
      disconnectedThreshold: 3,
    });
    conn.connect();
    for (let i = 0; i < 3; i++) {
      latest().drop();
      vi.advanceTimersByTime(60_000);
    }

    expect(onStateChange).toHaveBeenCalledWith('disconnected', expect.any(Number));
    conn.destroy();
  });

  // DOR-3482: a chat whose server restarted said "Live updates lost" until
  // somebody sent a message, because the socket stopped trying for good here.
  it('keeps retrying underneath disconnected, and recovers when the server is back', () => {
    const onStateChange = vi.fn();
    const conn = new WSConnection(TEST_URL, {
      eventHandlers: {},
      onStateChange,
      disconnectedThreshold: 3,
    });
    conn.connect();
    for (let i = 0; i < 3; i++) {
      latest().drop();
      vi.advanceTimersByTime(60_000);
    }
    expect(conn.getState()).toBe('disconnected');
    onStateChange.mockClear();

    // Still trying: a new socket opens at the backoff cap, without the label
    // flickering through `connecting` on each attempt.
    const before = FakeSocket.instances.length;
    latest().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(before);
    expect(onStateChange).not.toHaveBeenCalledWith('connecting', expect.any(Number));
    expect(conn.getState()).toBe('disconnected');

    latest().open();
    expect(conn.getState()).toBe('connected');
    conn.destroy();
  });

  it('tries at once when retryNow is called, rather than waiting out the backoff', () => {
    const conn = new WSConnection(TEST_URL, { eventHandlers: {}, backoffBaseMs: 60_000 });
    conn.connect();
    latest().drop();
    const before = FakeSocket.instances.length;

    conn.retryNow();

    expect(FakeSocket.instances.length).toBe(before + 1);
    // The cancelled backoff does not open a second socket later.
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances.length).toBe(before + 1);
    conn.destroy();
  });

  it('ignores retryNow on an open socket', () => {
    const conn = new WSConnection(TEST_URL, { eventHandlers: {} });
    conn.connect();
    latest().open();
    const before = FakeSocket.instances.length;

    conn.retryNow();

    expect(FakeSocket.instances.length).toBe(before);
    conn.destroy();
  });

  it('tries at once when the browser comes back online', () => {
    const conn = new WSConnection(TEST_URL, { eventHandlers: {}, backoffBaseMs: 60_000 });
    conn.connect();
    latest().drop();
    const before = FakeSocket.instances.length;

    window.dispatchEvent(new Event('online'));

    expect(FakeSocket.instances.length).toBe(before + 1);
    conn.destroy();
    // Destroyed streams stop listening.
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.instances.length).toBe(before + 1);
  });

  it('wakes the other streams to the same server when one gets back through', () => {
    // The list stream and the chat stream reach one server: one reconnecting
    // means it is back, so the chat stops waiting out a 30s backoff.
    const list = new WSConnection('/api/events', { eventHandlers: {}, backoffBaseMs: 60_000 });
    const chat = new WSConnection(TEST_URL, { eventHandlers: {}, backoffBaseMs: 60_000 });
    const elsewhere = new WSConnection('https://other.test/api/events', {
      eventHandlers: {},
      backoffBaseMs: 60_000,
    });
    list.connect();
    const listSocket = latest();
    chat.connect();
    const chatSocket = latest();
    elsewhere.connect();
    const elsewhereSocket = latest();
    listSocket.drop();
    chatSocket.drop();
    elsewhereSocket.drop();

    // The list stream's backoff fires first and gets through. Opening is not
    // enough; the first frame is what proves the server is really back.
    list.retryNow();
    const before = FakeSocket.instances.length;
    latest().open();
    expect(FakeSocket.instances.length).toBe(before);
    latest().deliver({ event: STREAM_HEARTBEAT_EVENT });

    const opened = FakeSocket.instances.slice(before).map((socket) => new URL(socket.url).host);
    expect(opened).toEqual(['localhost:3000']);
    expect(chat.getState()).not.toBe('connected');
    latest().open();
    expect(chat.getState()).toBe('connected');

    list.destroy();
    chat.destroy();
    elsewhere.destroy();
  });

  it('does not wake siblings for a socket the server opens and closes again', () => {
    // Two streams the server accepts and then closes must not wake each other
    // in a tight loop.
    const a = new WSConnection('/api/events', { eventHandlers: {}, backoffBaseMs: 60_000 });
    const b = new WSConnection(TEST_URL, { eventHandlers: {}, backoffBaseMs: 60_000 });
    a.connect();
    const aSocket = latest();
    b.connect();
    latest().drop();
    aSocket.drop();
    a.retryNow();
    const before = FakeSocket.instances.length;

    latest().open();
    latest().drop();

    expect(FakeSocket.instances.length).toBe(before);
    a.destroy();
    b.destroy();
  });

  it('keeps a socket parked by a hidden tab shut, even when the browser comes online', () => {
    const list = new WSConnection('/api/events', { eventHandlers: {} });
    list.connect();
    latest().open();
    list.enableVisibilityOptimization(1_000);
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(1_000);
      const parked = FakeSocket.instances.length;

      window.dispatchEvent(new Event('online'));
      list.retryNow();

      expect(FakeSocket.instances.length).toBe(parked);
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      list.destroy();
    }
  });

  it('wakes the waiting chat when a socket parked by a hidden tab comes back', () => {
    const list = new WSConnection('/api/events', { eventHandlers: {} });
    list.connect();
    latest().open();
    list.enableVisibilityOptimization(1_000);
    const chat = new WSConnection(TEST_URL, { eventHandlers: {}, backoffBaseMs: 60_000 });
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(1_000);
      chat.connect();
      latest().drop();

      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      latest().open();
      const before = FakeSocket.instances.length;
      latest().deliver({ event: STREAM_HEARTBEAT_EVENT });

      expect(FakeSocket.instances.length).toBe(before + 1);
      expect(latest().url).toContain('/api/sessions/abc/events');
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      list.destroy();
      chat.destroy();
    }
  });

  it('does not wake anything on a first connect that never failed', () => {
    const other = new WSConnection(TEST_URL, { eventHandlers: {}, backoffBaseMs: 60_000 });
    other.connect();
    latest().drop();
    const before = FakeSocket.instances.length;

    const fresh = new WSConnection('/api/events', { eventHandlers: {} });
    fresh.connect();
    latest().open();

    expect(FakeSocket.instances.length).toBe(before + 1);
    other.destroy();
    fresh.destroy();
  });

  it('stays down after a deliberate disconnect, whatever wakes it', () => {
    const conn = new WSConnection(TEST_URL, { eventHandlers: {} });
    conn.connect();
    latest().open();
    conn.disconnect();
    const before = FakeSocket.instances.length;

    conn.retryNow();
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(120_000);

    expect(FakeSocket.instances.length).toBe(before);
    conn.destroy();
  });

  it('does NOT count a caller-requested close as a failure', () => {
    // `disconnect()` then `connect()` is how a re-target works; counting it as an
    // outage would spend the failure budget on healthy switching.
    const conn = new WSConnection(TEST_URL, { eventHandlers: {} });
    conn.connect();
    latest().open();

    conn.disconnect();
    vi.advanceTimersByTime(60_000);

    expect(conn.getFailedAttempts()).toBe(0);
    conn.destroy();
  });

  it('stops reconnecting once destroyed', () => {
    const conn = new WSConnection(TEST_URL, { eventHandlers: {} });
    conn.connect();
    latest().open();
    const count = FakeSocket.instances.length;

    conn.destroy();
    vi.advanceTimersByTime(120_000);

    expect(FakeSocket.instances.length).toBe(count);
  });

  it('drops an unparseable frame without tearing the stream down', () => {
    const handler = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const conn = new WSConnection(TEST_URL, { eventHandlers: { text_delta: handler } });
    conn.connect();
    latest().open();

    latest().onmessage?.({ data: 'not json at all' } as MessageEvent<unknown>);
    latest().deliver({ event: 'text_delta', data: { ok: true } });

    expect(warn).toHaveBeenCalled();
    expect(handler, 'the stream carried on').toHaveBeenCalledWith({ ok: true });
    warn.mockRestore();
    conn.destroy();
  });

  it('STOPS and says why when the server refuses the stream', async () => {
    // The failure shape this prevents: a too-narrow origin allowlist refused
    // every stream, and because a browser cannot read a failed handshake the
    // cockpit just retried five times into a silent `disconnected`. The page
    // rendered, requests worked, the turn ran, and nothing said the stream was
    // being turned away.
    const onError = vi.fn();
    const onStateChange = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conn = new WSConnection(TEST_URL, { eventHandlers: {}, onError, onStateChange });
    conn.connect();
    latest().open();
    const opened = FakeSocket.instances.length;

    latest().refuse(403, 'Origin not trusted');
    vi.advanceTimersByTime(120_000);

    expect(FakeSocket.instances.length, 'retrying a refusal cannot help').toBe(opened);
    expect(onStateChange).toHaveBeenCalledWith('disconnected', expect.any(Number));
    const reported = onError.mock.calls.at(-1)?.[0] as StreamRefusedError;
    expect(reported).toBeInstanceOf(StreamRefusedError);
    expect(reported.status).toBe(403);
    expect(reported.message, 'a 403 names the setting that fixes it').toMatch(
      /DORKOS_TRUSTED_HOSTS/
    );
    expect(errors, 'and it is visible in the console').toHaveBeenCalled();
    errors.mockRestore();
    conn.destroy();
  });

  it('stays down after a refusal, even when the browser comes back online', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const conn = new WSConnection(TEST_URL, { eventHandlers: {} });
    conn.connect();
    latest().refuse(403);
    const before = FakeSocket.instances.length;

    conn.retryNow();
    window.dispatchEvent(new Event('online'));

    expect(FakeSocket.instances.length).toBe(before);
    conn.destroy();
  });

  it('still RETRIES an ordinary drop, which is not a refusal', async () => {
    const conn = new WSConnection(TEST_URL, { eventHandlers: {} });
    conn.connect();
    latest().open();
    const opened = FakeSocket.instances.length;

    latest().drop();
    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.instances.length).toBeGreaterThan(opened);
    conn.destroy();
  });

  it('reports a socket parked by a hidden tab as down, and its reopen as a recovery (DOR-2896)', () => {
    // The global stream has no replay, so a parked socket misses events. Only a
    // down state lets the caller re-sync when the tab is shown again.
    const onStateChange = vi.fn();
    const conn = new WSConnection(TEST_URL, { eventHandlers: {}, onStateChange });
    conn.connect();
    latest().open();
    conn.enableVisibilityOptimization(1_000);
    onStateChange.mockClear();

    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(1_000);
      expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(['reconnecting']);

      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      latest().open();
      expect(onStateChange.mock.calls.map(([state]) => state)).toEqual([
        'reconnecting',
        'connecting',
        'connected',
      ]);
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      conn.destroy();
    }
  });
});
