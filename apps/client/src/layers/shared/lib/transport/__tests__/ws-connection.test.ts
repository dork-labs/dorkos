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

  it('gives up after the failure threshold and reports disconnected', () => {
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
});
