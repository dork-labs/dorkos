/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionState } from '@dorkos/shared/types';
import { SSEConnection, type SSEConnectionOptions } from '../sse-connection';

// ---------------------------------------------------------------------------
// Mock fetch + SSE stream helpers
// ---------------------------------------------------------------------------

function createMockSSEStream() {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  return {
    readable,
    writer,
    sendEvent(type: string, data: unknown) {
      writer.write(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    sendHeartbeat() {
      writer.write(encoder.encode(`: heartbeat\n\n`));
    },
    sendComment(text: string) {
      writer.write(encoder.encode(`: ${text}\n\n`));
    },
    sendRetry(ms: number) {
      // retry: alone has no data, so the parser won't yield an event.
      // Pair with a data event so the retry value is delivered to SSEConnection.
      writer.write(encoder.encode(`retry: ${ms}\nevent: sync_update\ndata: {"retry":true}\n\n`));
    },
    sendEventWithId(type: string, data: unknown, id: string) {
      writer.write(encoder.encode(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    sendRawData(type: string, raw: string) {
      writer.write(encoder.encode(`event: ${type}\ndata: ${raw}\n\n`));
    },
    close() {
      return writer.close();
    },
    error(err: Error) {
      return writer.abort(err);
    },
  };
}

let mockStream: ReturnType<typeof createMockSSEStream>;
let fetchCallCount: number;

const TEST_URL = 'http://localhost:6242/api/sessions/test/stream';

function createConnection(overrides: Partial<SSEConnectionOptions> = {}) {
  const onStateChange = vi.fn<(state: ConnectionState, attempts: number) => void>();
  const onError = vi.fn();
  const handler = vi.fn();

  const conn = new SSEConnection(TEST_URL, {
    eventHandlers: { sync_update: handler },
    onStateChange,
    onError,
    heartbeatTimeoutMs: 5_000,
    backoffBaseMs: 100,
    backoffCapMs: 1_000,
    disconnectedThreshold: 3,
    stabilityWindowMs: 2_000,
    ...overrides,
  });

  return { conn, onStateChange, onError, handler };
}

function setupFetchMock() {
  mockStream = createMockSSEStream();
  fetchCallCount = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      fetchCallCount++;
      // Each call after the first creates a new stream
      if (fetchCallCount > 1) {
        mockStream = createMockSSEStream();
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: mockStream.readable,
      });
    })
  );
}

/**
 * Set up fetch mock that returns an HTTP error response.
 *
 * @param status - HTTP status code
 * @param statusText - HTTP status text
 */
function setupFetchErrorMock(status: number, statusText: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status,
        statusText,
        body: null,
      })
    )
  );
}

/**
 * Set up fetch mock that throws a network error (like DNS failure or offline).
 */
function setupFetchNetworkError() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
  );
}

/**
 * Turn the event loop until `settled()` holds, WITHOUT moving the fake clock.
 *
 * `advanceTimersByTimeAsync(0)` buys exactly one real event-loop turn, and one
 * turn is a bet rather than a barrier for anything that crosses Node's stream
 * internals. Those resume on the loop's check phase; the fake clock resumes on a
 * real 1ms timer of its own — and which of the two lands first is the
 * scheduler's call. On an idle machine the stream always wins; with three of
 * these suites running at once it lost 6 times in 1200 (measured), leaving the
 * connection still reading `connected` when the test asserted it had noticed the
 * close. That is DOR-798. Waiting on the state the close produces cannot lose
 * that race, and passing `0` never fires a pending backoff timer, so the
 * backoff-window assertions below stay honest.
 *
 * Bounded by a turn count rather than a wall-clock deadline — the deliberate
 * opposite of the server's `flushIoUntil`, which can read a real `Date.now()`
 * because it fakes only `setTimeout`. Here the clock itself is faked, so there
 * is no wall clock to bound against; 100 turns is a 100x margin over the single
 * turn this ever needs, and exhausting it leaves the caller's own assertion to
 * report the failure.
 */
async function untilSettled(settled: () => boolean, turns = 100): Promise<void> {
  for (let i = 0; i < turns && !settled(); i++) await vi.advanceTimersByTimeAsync(0);
}

/**
 * End the live mock stream — the server-disconnect simulation — and return once
 * `conn` has registered the disconnect. A failed attempt is counted on exactly
 * that path ({@link SSEConnection}'s error handler), so it is the observable
 * that says the close arrived, whatever state it moves the connection into.
 */
async function closeStream(conn: SSEConnection): Promise<void> {
  const before = conn.getFailedAttempts();
  mockStream.close();
  await untilSettled(() => conn.getFailedAttempts() > before);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SSEConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupFetchMock();
    // Pin the backoff jitter for EVERY test. `calculateBackoff` multiplies its
    // window by `Math.random()`, so roughly one draw in two hundred lands under
    // a millisecond — and a sub-millisecond timer is already due on a
    // zero-length advance, because the fake clock rounds its target down to a
    // whole millisecond (verified: a 0.65ms timer fires on
    // `advanceTimersByTimeAsync(0)`, a 1ms one does not). The reconnect then
    // happens inside the very tick that delivers the disconnect, and the
    // `reconnecting` state a test is about to assert never exists to be seen. It
    // is not the machine's fault and no amount of waiting helps: the input was
    // never pinned. Tests that care about a particular draw override this.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  describe('state transitions', () => {
    it('starts in connecting state', () => {
      const { conn } = createConnection();
      expect(conn.getState()).toBe('connecting');
    });

    it('transitions to connecting then connected on successful fetch', async () => {
      const { conn, onStateChange } = createConnection();
      conn.connect();

      // Let fetch resolve and stream consumption begin
      await vi.advanceTimersByTimeAsync(0);

      expect(conn.getState()).toBe('connected');
      expect(onStateChange).toHaveBeenCalledWith('connected', 0);
    });

    it('transitions to reconnecting when stream ends unexpectedly', async () => {
      const { conn, onStateChange } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(conn.getState()).toBe('connected');
      onStateChange.mockClear();

      // Close the stream — simulates server disconnect
      await closeStream(conn);

      expect(conn.getState()).toBe('reconnecting');
      expect(conn.getFailedAttempts()).toBe(1);
      expect(onStateChange).toHaveBeenCalledWith('reconnecting', 1);
    });

    it('reconnects automatically after backoff delay', async () => {
      // The pinned jitter makes this a NAMED 100ms backoff — 0.5 * min(1000,
      // 100*2^1) — instead of "somewhere under 200ms", so the test checks the
      // boundary it means to check rather than sleeping past a window and
      // trusting the window is wide enough.
      const { conn } = createConnection();
      conn.connect();
      await untilSettled(() => conn.getState() === 'connected');

      await closeStream(conn);
      expect(conn.getState()).toBe('reconnecting');
      const attemptsBefore = fetchCallCount;

      // A millisecond short of the backoff: nothing has been re-opened yet.
      await vi.advanceTimersByTimeAsync(99);
      expect(fetchCallCount).toBe(attemptsBefore);
      expect(conn.getState()).toBe('reconnecting');

      // The backoff fires. "Reconnects" means a NEW connection was actually
      // opened, not merely that a state string moved.
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchCallCount).toBe(attemptsBefore + 1);
      await untilSettled(() => conn.getState() === 'connected');
      expect(conn.getState()).toBe('connected');
    });

    it('transitions to disconnected after threshold failures', async () => {
      const { conn, onStateChange } = createConnection({
        disconnectedThreshold: 2,
        heartbeatTimeoutMs: 0,
        stabilityWindowMs: 60_000,
      });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(conn.getState()).toBe('connected');

      // First failure -> reconnecting
      await closeStream(conn);
      expect(conn.getState()).toBe('reconnecting');
      expect(conn.getFailedAttempts()).toBe(1);

      // Attempt 1: max = min(1000, 100*2^1) = 200, delay = 0.5 * 200 = 100
      await vi.advanceTimersByTimeAsync(101);
      expect(conn.getState()).toBe('connected');

      // Second failure -> exceeds threshold -> disconnected
      await closeStream(conn);

      expect(conn.getState()).toBe('disconnected');
      expect(conn.getFailedAttempts()).toBe(2);
      expect(onStateChange).toHaveBeenCalledWith('disconnected', 2);
    });
  });

  // -------------------------------------------------------------------------
  // Backoff calculation
  // -------------------------------------------------------------------------

  describe('backoff calculation', () => {
    it('delay is within expected range based on attempt count', async () => {
      const { conn } = createConnection();

      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      await closeStream(conn);

      // Attempt 1: max = min(1000, 100*2^1) = 200, delay = 0.5 * 200 = 100
      expect(conn.getState()).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(99);
      expect(conn.getState()).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(1);
      // After backoff fires, connect() fires -> fetch resolves -> connected
      expect(conn.getState()).toBe('connected');
    });

    it('caps backoff at backoffCapMs', async () => {
      const { conn } = createConnection({ backoffCapMs: 500, disconnectedThreshold: 10 });
      vi.spyOn(Math, 'random').mockReturnValue(1);

      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      // Fail multiple times to push attempt count high
      for (let i = 0; i < 5; i++) {
        // Each iteration must close a LIVE stream, or it counts no failure.
        await untilSettled(() => conn.getState() === 'connected');
        await closeStream(conn);
        // Advance past max backoff cap
        await vi.advanceTimersByTimeAsync(501);
      }

      // Should still be reconnecting / connected, not disconnected
      expect(conn.getState()).not.toBe('disconnected');
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat watchdog
  // -------------------------------------------------------------------------

  describe('heartbeat watchdog', () => {
    it('fires reconnection after heartbeat timeout with no events', async () => {
      const { conn } = createConnection({ heartbeatTimeoutMs: 3_000 });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(conn.getState()).toBe('connected');

      await vi.advanceTimersByTimeAsync(3_000);

      expect(conn.getState()).toBe('reconnecting');
      expect(conn.getFailedAttempts()).toBe(1);
    });

    it('resets watchdog timer when an event is received', async () => {
      const { conn, handler } = createConnection({ heartbeatTimeoutMs: 3_000 });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      // Advance 2 seconds, then receive an event
      await vi.advanceTimersByTimeAsync(2_000);
      mockStream.sendEvent('sync_update', { type: 'test' });
      await vi.advanceTimersByTimeAsync(0);

      // Advance another 2 seconds — should still be connected because watchdog was reset
      await vi.advanceTimersByTimeAsync(2_000);
      expect(conn.getState()).toBe('connected');

      // Advance to full timeout from last event — should trigger reconnect
      await vi.advanceTimersByTimeAsync(1_000);
      expect(conn.getState()).toBe('reconnecting');
      expect(handler).toHaveBeenCalledWith({ type: 'test' });
    });

    it('resets watchdog on heartbeat comments', async () => {
      const { conn } = createConnection({ heartbeatTimeoutMs: 3_000 });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(2_000);
      mockStream.sendHeartbeat();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(conn.getState()).toBe('connected');
    });

    it('does not start watchdog when heartbeatTimeoutMs is 0', async () => {
      const { conn } = createConnection({ heartbeatTimeoutMs: 0 });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(100_000);
      expect(conn.getState()).toBe('connected');
    });
  });

  // -------------------------------------------------------------------------
  // Max retries / disconnected threshold
  // -------------------------------------------------------------------------

  describe('max retries', () => {
    it('enters disconnected state after threshold failures', async () => {
      const { conn, onStateChange } = createConnection({
        disconnectedThreshold: 3,
        heartbeatTimeoutMs: 0,
        stabilityWindowMs: 60_000,
      });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      // Fail twice, reconnecting each time
      for (let i = 0; i < 2; i++) {
        await closeStream(conn);
        expect(conn.getState()).toBe('reconnecting');
        // Attempt i+1: backoff = 0.5 * min(1000, 100*2^(i+1))
        // i=0: 0.5 * 200 = 100, i=1: 0.5 * 400 = 200
        await vi.advanceTimersByTimeAsync(201);
        expect(conn.getState()).toBe('connected');
      }

      expect(conn.getFailedAttempts()).toBe(2);

      // Third failure pushes past threshold
      await closeStream(conn);

      expect(conn.getState()).toBe('disconnected');
      expect(conn.getFailedAttempts()).toBe(3);
      expect(onStateChange).toHaveBeenCalledWith('disconnected', 3);
    });

    it('does not attempt reconnection after entering disconnected state', async () => {
      const { conn } = createConnection({ disconnectedThreshold: 1 });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      await closeStream(conn);

      expect(conn.getState()).toBe('disconnected');
      const callCount = fetchCallCount;

      await vi.advanceTimersByTimeAsync(100_000);
      expect(fetchCallCount).toBe(callCount);
    });
  });

  // -------------------------------------------------------------------------
  // Stability window
  // -------------------------------------------------------------------------

  describe('stability window', () => {
    it('resets attempt counter after connection is stable', async () => {
      const { conn, onStateChange } = createConnection({ stabilityWindowMs: 2_000 });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      await closeStream(conn);
      expect(conn.getFailedAttempts()).toBe(1);

      // Attempt 1: max = min(1000, 100*2^1) = 200, delay = 0.5 * 200 = 100
      // Advance just past backoff to trigger reconnect, then let fetch resolve
      await vi.advanceTimersByTimeAsync(101);
      expect(conn.getState()).toBe('connected');

      // Now wait for stability window (2000ms) from the reconnected state
      await vi.advanceTimersByTimeAsync(2_000);

      expect(conn.getFailedAttempts()).toBe(0);
      expect(onStateChange).toHaveBeenCalledWith('connected', 0);
    });

    it('does not reset attempt counter if connection fails before stability window', async () => {
      const { conn } = createConnection({ stabilityWindowMs: 5_000 });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      await closeStream(conn);
      expect(conn.getFailedAttempts()).toBe(1);

      // Reconnect after backoff
      await vi.advanceTimersByTimeAsync(10_000);
      expect(conn.getState()).toBe('connected');

      // Fail before stability window elapses
      await vi.advanceTimersByTimeAsync(3_000);
      await closeStream(conn);

      expect(conn.getFailedAttempts()).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // destroy()
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('aborts fetch and prevents future connections', async () => {
      const { conn } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      conn.destroy();

      const callCount = fetchCallCount;
      conn.connect();
      // connect() should be a no-op after destroy
      expect(fetchCallCount).toBe(callCount);
    });

    it('prevents reconnection after destroy', async () => {
      const { conn } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      conn.destroy();

      const callCount = fetchCallCount;
      conn.connect();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(fetchCallCount).toBe(callCount);
    });

    it('does not trigger watchdog after destroy', async () => {
      const { conn, onStateChange } = createConnection({ heartbeatTimeoutMs: 1_000 });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      onStateChange.mockClear();
      conn.destroy();

      await vi.advanceTimersByTimeAsync(5_000);
      // No reconnecting state change should occur after destroy
      expect(onStateChange).not.toHaveBeenCalledWith('reconnecting', expect.any(Number));
    });

    it('removes visibility listener', async () => {
      const spy = vi.spyOn(document, 'removeEventListener');
      const { conn } = createConnection();
      conn.connect();
      conn.enableVisibilityOptimization();
      conn.destroy();

      expect(spy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });
  });

  // -------------------------------------------------------------------------
  // disconnect()
  // -------------------------------------------------------------------------

  describe('disconnect', () => {
    it('aborts fetch and sets state to disconnected', async () => {
      const { conn, onStateChange } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      onStateChange.mockClear();
      conn.disconnect();

      expect(conn.getState()).toBe('disconnected');
      expect(onStateChange).toHaveBeenCalledWith('disconnected', 0);
    });

    it('can reconnect after disconnect (unlike destroy)', async () => {
      const { conn } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      conn.disconnect();

      expect(conn.getState()).toBe('disconnected');

      const callCount = fetchCallCount;
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchCallCount).toBe(callCount + 1);
      expect(conn.getState()).toBe('connected');
    });
  });

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  describe('event handlers', () => {
    it('dispatches parsed JSON data to the correct handler', async () => {
      const { conn, handler } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      mockStream.sendEvent('sync_update', { id: 42, name: 'test' });
      await vi.advanceTimersByTimeAsync(0);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ id: 42, name: 'test' });
    });

    it('passes raw data when JSON parsing fails', async () => {
      const rawHandler = vi.fn();
      const conn = new SSEConnection(TEST_URL, {
        eventHandlers: { raw_event: rawHandler },
        heartbeatTimeoutMs: 0,
      });

      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      mockStream.sendRawData('raw_event', 'not-json');
      await vi.advanceTimersByTimeAsync(0);

      expect(rawHandler).toHaveBeenCalledWith('not-json');
    });

    it('updates lastEventAt on receiving events', async () => {
      const { conn } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(conn.getLastEventAt()).toBeNull();

      vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
      mockStream.sendEvent('sync_update', {});
      await vi.advanceTimersByTimeAsync(0);

      expect(conn.getLastEventAt()).toBe(new Date('2026-01-01T00:00:05Z').getTime());
    });

    it('registers handlers for multiple event types', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const conn = new SSEConnection(TEST_URL, {
        eventHandlers: { type_a: handler1, type_b: handler2 },
        heartbeatTimeoutMs: 0,
      });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      mockStream.sendEvent('type_a', { a: 1 });
      await vi.advanceTimersByTimeAsync(0);
      mockStream.sendEvent('type_b', { b: 2 });
      await vi.advanceTimersByTimeAsync(0);

      expect(handler1).toHaveBeenCalledWith({ a: 1 });
      expect(handler2).toHaveBeenCalledWith({ b: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // onStateChange callback
  // -------------------------------------------------------------------------

  describe('onStateChange callback', () => {
    it('is called with correct state and attempt count on each transition', async () => {
      const { conn, onStateChange } = createConnection({
        disconnectedThreshold: 2,
        // Large stability window so it doesn't reset failedAttempts during test
        stabilityWindowMs: 60_000,
      });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(onStateChange).toHaveBeenCalledWith('connected', 0);

      await closeStream(conn);
      expect(onStateChange).toHaveBeenCalledWith('reconnecting', 1);

      // Backoff fires -> connect() -> 'connecting'
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onStateChange).toHaveBeenCalledWith('connecting', 1);

      // Fetch resolves -> 'connected'
      expect(onStateChange).toHaveBeenCalledWith('connected', 1);

      // Second failure -> disconnected
      await closeStream(conn);
      expect(onStateChange).toHaveBeenCalledWith('disconnected', 2);
    });

    it('is not called when state does not change', () => {
      const { conn, onStateChange } = createConnection();
      // Initial state is 'connecting', calling connect() sets 'connecting' again — no-op
      conn.connect();
      expect(onStateChange).not.toHaveBeenCalledWith('connecting', expect.any(Number));
    });
  });

  // -------------------------------------------------------------------------
  // onError callback
  // -------------------------------------------------------------------------

  describe('onError callback', () => {
    it('is called with Error object when stream ends', async () => {
      const { conn, onError } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      await closeStream(conn);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  // -------------------------------------------------------------------------
  // connect() idempotency
  // -------------------------------------------------------------------------

  describe('connect() idempotency', () => {
    it('aborts existing fetch before opening new one', async () => {
      const { conn } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      const firstCallCount = fetchCallCount;
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchCallCount).toBe(firstCallCount + 1);
    });
  });

  // -------------------------------------------------------------------------
  // Visibility optimization
  // -------------------------------------------------------------------------

  describe('enableVisibilityOptimization', () => {
    it('registers visibilitychange listener', () => {
      const spy = vi.spyOn(document, 'addEventListener');
      const { conn } = createConnection();
      conn.enableVisibilityOptimization(5_000);

      expect(spy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });

    it('does not register duplicate listeners', () => {
      const spy = vi.spyOn(document, 'addEventListener');
      const { conn } = createConnection();
      conn.enableVisibilityOptimization(5_000);
      conn.enableVisibilityOptimization(5_000);

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Custom headers
  // -------------------------------------------------------------------------

  describe('sends custom headers', () => {
    it('includes headers option in fetch request', async () => {
      const { conn } = createConnection({
        headers: { Authorization: 'Bearer token-123', 'X-Custom': 'value' },
      });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      const fetchFn = vi.mocked(fetch);
      expect(fetchFn).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'text/event-stream',
            Authorization: 'Bearer token-123',
            'X-Custom': 'value',
          }),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Last-Event-ID on reconnect
  // -------------------------------------------------------------------------

  describe('sends Last-Event-ID on reconnect', () => {
    it('includes Last-Event-ID header after receiving id: event', async () => {
      const { conn } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      // Send an event with id
      mockStream.sendEventWithId('sync_update', { id: 1 }, 'evt-42');
      await vi.advanceTimersByTimeAsync(0);

      // Close stream to trigger reconnection
      await closeStream(conn);

      // Advance past backoff to trigger reconnect
      await vi.advanceTimersByTimeAsync(10_000);

      const fetchFn = vi.mocked(fetch);
      const lastCall = fetchFn.mock.calls[fetchFn.mock.calls.length - 1];
      expect(lastCall?.[1]?.headers).toEqual(
        expect.objectContaining({
          'Last-Event-ID': 'evt-42',
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Server retry: as backoff floor
  // -------------------------------------------------------------------------

  describe('honors server retry: as backoff floor', () => {
    it('uses retry value as minimum backoff delay', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // Minimum jitter -> 0ms client delay

      const { conn } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      // Server sends retry: 5000
      mockStream.sendRetry(5000);
      await vi.advanceTimersByTimeAsync(0);

      // Close stream to trigger reconnection
      await closeStream(conn);

      expect(conn.getState()).toBe('reconnecting');

      // Even though client jitter is 0ms, server retry: 5000 is the floor
      await vi.advanceTimersByTimeAsync(4_999);
      expect(conn.getState()).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(1);
      // After 5000ms total the backoff fires
      expect(conn.getState()).toBe('connected');
    });
  });

  // -------------------------------------------------------------------------
  // Resets watchdog on comment lines
  // -------------------------------------------------------------------------

  describe('resets watchdog on comment lines', () => {
    it('comment keepalive prevents watchdog timeout', async () => {
      const { conn } = createConnection({ heartbeatTimeoutMs: 3_000 });
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(2_000);
      mockStream.sendComment('keepalive');
      await vi.advanceTimersByTimeAsync(0);

      // 2 more seconds — still connected because watchdog was reset by comment
      await vi.advanceTimersByTimeAsync(2_000);
      expect(conn.getState()).toBe('connected');

      // Full timeout from last comment — should trigger reconnect
      await vi.advanceTimersByTimeAsync(1_000);
      expect(conn.getState()).toBe('reconnecting');
    });
  });

  // -------------------------------------------------------------------------
  // HTTP error responses
  // -------------------------------------------------------------------------

  describe('handles HTTP error responses', () => {
    it('4xx response triggers handleConnectionError', async () => {
      setupFetchErrorMock(403, 'Forbidden');

      const { conn, onError } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(conn.getState()).toBe('reconnecting');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'HTTP 403: Forbidden' })
      );
    });

    it('5xx response triggers handleConnectionError', async () => {
      setupFetchErrorMock(500, 'Internal Server Error');

      const { conn, onError } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(conn.getState()).toBe('reconnecting');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'HTTP 500: Internal Server Error' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Fetch network errors
  // -------------------------------------------------------------------------

  describe('handles fetch network error', () => {
    it('TypeError triggers reconnection', async () => {
      setupFetchNetworkError();

      const { conn, onError } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(conn.getState()).toBe('reconnecting');
      expect(onError).toHaveBeenCalledWith(expect.any(TypeError));
    });
  });

  // -------------------------------------------------------------------------
  // Abort on disconnect
  // -------------------------------------------------------------------------

  describe('aborts fetch on disconnect()', () => {
    it('AbortController signal is aborted', async () => {
      const { conn } = createConnection();
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      // Capture the AbortSignal from the fetch call
      const fetchFn = vi.mocked(fetch);
      const signal = fetchFn.mock.calls[0]?.[1]?.signal as AbortSignal;
      expect(signal.aborted).toBe(false);

      conn.disconnect();

      expect(signal.aborted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // New AbortController on each connect()
  // -------------------------------------------------------------------------

  describe('creates new AbortController on each connect()', () => {
    it('never reuses AbortController across connections', async () => {
      const { conn } = createConnection();

      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      const fetchFn = vi.mocked(fetch);
      const firstSignal = fetchFn.mock.calls[0]?.[1]?.signal as AbortSignal;

      // Reconnect
      conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      const secondSignal = fetchFn.mock.calls[1]?.[1]?.signal as AbortSignal;

      // The first signal should be aborted (closeConnection called in connect())
      expect(firstSignal.aborted).toBe(true);
      // The second signal should be a different instance and not aborted
      expect(secondSignal).not.toBe(firstSignal);
      expect(secondSignal.aborted).toBe(false);
    });
  });
});
