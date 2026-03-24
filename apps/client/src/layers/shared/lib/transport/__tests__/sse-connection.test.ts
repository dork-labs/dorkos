import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionState } from '@dorkos/shared/types';
import { SSEConnection, type SSEConnectionOptions } from '../sse-connection';

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((h) => h !== handler)
    );
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }

  simulateEvent(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }

  static reset() {
    MockEventSource.instances = [];
  }

  static latest() {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

vi.stubGlobal('EventSource', MockEventSource);

/** Shorthand defaults for test options. */
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

describe('SSEConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.reset();
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

    it('transitions to connecting then connected on open', () => {
      const { conn, onStateChange } = createConnection();
      conn.connect();

      // connect() sets state to 'connecting' (already the initial state, so
      // setState is a no-op because state === newState)
      MockEventSource.latest().simulateOpen();

      expect(conn.getState()).toBe('connected');
      expect(onStateChange).toHaveBeenCalledWith('connected', 0);
    });

    it('transitions to reconnecting on error', () => {
      const { conn, onStateChange } = createConnection();
      conn.connect();
      MockEventSource.latest().simulateOpen();

      onStateChange.mockClear();
      MockEventSource.latest().simulateError();

      expect(conn.getState()).toBe('reconnecting');
      expect(conn.getFailedAttempts()).toBe(1);
      expect(onStateChange).toHaveBeenCalledWith('reconnecting', 1);
    });

    it('reconnects automatically after backoff delay', () => {
      const { conn } = createConnection();
      conn.connect();
      MockEventSource.latest().simulateOpen();
      MockEventSource.latest().simulateError();

      expect(conn.getState()).toBe('reconnecting');
      const instancesBefore = MockEventSource.instances.length;

      // Advance past the maximum possible backoff for attempt 1: cap = min(1000, 100*2^1) = 200
      vi.advanceTimersByTime(201);

      expect(MockEventSource.instances.length).toBe(instancesBefore + 1);
    });
  });

  // -------------------------------------------------------------------------
  // Backoff calculation
  // -------------------------------------------------------------------------

  describe('backoff calculation', () => {
    it('delay is within expected range based on attempt count', () => {
      // We test indirectly: after error, the reconnect must happen within
      // the maximum possible delay (full jitter: 0 to min(cap, base*2^attempt))
      const { conn } = createConnection();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      conn.connect();
      MockEventSource.latest().simulateOpen();
      MockEventSource.latest().simulateError();

      // Attempt 1: max = min(1000, 100*2^1) = 200, delay = 0.5 * 200 = 100
      const instancesBefore = MockEventSource.instances.length;

      vi.advanceTimersByTime(99);
      expect(MockEventSource.instances.length).toBe(instancesBefore);

      vi.advanceTimersByTime(1);
      expect(MockEventSource.instances.length).toBe(instancesBefore + 1);
    });

    it('caps backoff at backoffCapMs', () => {
      const { conn } = createConnection({ backoffCapMs: 500 });
      vi.spyOn(Math, 'random').mockReturnValue(1);

      conn.connect();
      // Fail multiple times to increase attempt count
      for (let i = 0; i < 2; i++) {
        MockEventSource.latest().simulateOpen();
        MockEventSource.latest().simulateError();
        // Advance past max backoff to trigger reconnect
        vi.advanceTimersByTime(501);
      }

      // At attempt 2: min(500, 100*2^2) = 400, random=1 -> delay=400
      // Verify the connection is still reconnecting (not disconnected yet)
      expect(conn.getState()).not.toBe('disconnected');
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat watchdog
  // -------------------------------------------------------------------------

  describe('heartbeat watchdog', () => {
    it('fires reconnection after heartbeat timeout with no events', () => {
      const { conn } = createConnection({ heartbeatTimeoutMs: 3_000 });
      conn.connect();
      MockEventSource.latest().simulateOpen();

      expect(conn.getState()).toBe('connected');

      vi.advanceTimersByTime(3_000);

      expect(conn.getState()).toBe('reconnecting');
      expect(conn.getFailedAttempts()).toBe(1);
    });

    it('resets watchdog timer when an event is received', () => {
      const { conn, handler } = createConnection({ heartbeatTimeoutMs: 3_000 });
      conn.connect();
      MockEventSource.latest().simulateOpen();

      // Advance 2 seconds, then receive an event
      vi.advanceTimersByTime(2_000);
      MockEventSource.latest().simulateEvent('sync_update', { type: 'test' });

      // Advance another 2 seconds — should still be connected because watchdog was reset
      vi.advanceTimersByTime(2_000);
      expect(conn.getState()).toBe('connected');

      // Advance to full timeout from last event — should trigger reconnect
      vi.advanceTimersByTime(1_000);
      expect(conn.getState()).toBe('reconnecting');
      expect(handler).toHaveBeenCalledWith({ type: 'test' });
    });

    it('resets watchdog on heartbeat events', () => {
      const { conn } = createConnection({ heartbeatTimeoutMs: 3_000 });
      conn.connect();
      MockEventSource.latest().simulateOpen();

      vi.advanceTimersByTime(2_000);
      MockEventSource.latest().simulateEvent('heartbeat', {});

      vi.advanceTimersByTime(2_000);
      expect(conn.getState()).toBe('connected');
    });

    it('does not start watchdog when heartbeatTimeoutMs is 0', () => {
      const { conn } = createConnection({ heartbeatTimeoutMs: 0 });
      conn.connect();
      MockEventSource.latest().simulateOpen();

      vi.advanceTimersByTime(100_000);
      expect(conn.getState()).toBe('connected');
    });
  });

  // -------------------------------------------------------------------------
  // Max retries / disconnected threshold
  // -------------------------------------------------------------------------

  describe('max retries', () => {
    it('enters disconnected state after threshold failures', () => {
      const { conn, onStateChange } = createConnection({ disconnectedThreshold: 3 });
      conn.connect();

      for (let i = 0; i < 2; i++) {
        MockEventSource.latest().simulateOpen();
        MockEventSource.latest().simulateError();
        // After error: state is 'reconnecting', then backoff fires → connect() → 'connecting'
        vi.advanceTimersByTime(10_000); // past any backoff
      }

      // After backoff fires, connect() sets state to 'connecting'
      expect(conn.getState()).toBe('connecting');

      // Third failure pushes past threshold
      MockEventSource.latest().simulateOpen();
      MockEventSource.latest().simulateError();

      expect(conn.getState()).toBe('disconnected');
      expect(conn.getFailedAttempts()).toBe(3);
      expect(onStateChange).toHaveBeenCalledWith('disconnected', 3);
    });

    it('does not attempt reconnection after entering disconnected state', () => {
      const { conn } = createConnection({ disconnectedThreshold: 1 });
      conn.connect();
      MockEventSource.latest().simulateOpen();
      MockEventSource.latest().simulateError();

      expect(conn.getState()).toBe('disconnected');
      const instanceCount = MockEventSource.instances.length;

      vi.advanceTimersByTime(100_000);
      expect(MockEventSource.instances.length).toBe(instanceCount);
    });
  });

  // -------------------------------------------------------------------------
  // Stability window
  // -------------------------------------------------------------------------

  describe('stability window', () => {
    it('resets attempt counter after connection is stable', () => {
      const { conn, onStateChange } = createConnection({
        stabilityWindowMs: 2_000,
      });
      conn.connect();
      MockEventSource.latest().simulateOpen();
      MockEventSource.latest().simulateError();

      expect(conn.getFailedAttempts()).toBe(1);

      // Reconnect after backoff
      vi.advanceTimersByTime(10_000);
      MockEventSource.latest().simulateOpen();

      // Wait for stability window
      vi.advanceTimersByTime(2_000);

      expect(conn.getFailedAttempts()).toBe(0);
      expect(onStateChange).toHaveBeenCalledWith('connected', 0);
    });

    it('does not reset attempt counter if connection fails before stability window', () => {
      const { conn } = createConnection({ stabilityWindowMs: 5_000 });
      conn.connect();
      MockEventSource.latest().simulateOpen();
      MockEventSource.latest().simulateError();

      expect(conn.getFailedAttempts()).toBe(1);

      vi.advanceTimersByTime(10_000);
      MockEventSource.latest().simulateOpen();

      // Fail before stability window elapses
      vi.advanceTimersByTime(3_000);
      MockEventSource.latest().simulateError();

      expect(conn.getFailedAttempts()).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // destroy()
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('closes EventSource and clears all timers', () => {
      const { conn } = createConnection();
      conn.connect();
      const es = MockEventSource.latest();
      es.simulateOpen();

      conn.destroy();

      expect(es.readyState).toBe(MockEventSource.CLOSED);
    });

    it('prevents reconnection after destroy', () => {
      const { conn } = createConnection();
      conn.connect();
      conn.destroy();

      const instanceCount = MockEventSource.instances.length;
      conn.connect();
      expect(MockEventSource.instances.length).toBe(instanceCount);
    });

    it('does not trigger watchdog after destroy', () => {
      const { conn, onStateChange } = createConnection({ heartbeatTimeoutMs: 1_000 });
      conn.connect();
      MockEventSource.latest().simulateOpen();

      onStateChange.mockClear();
      conn.destroy();

      vi.advanceTimersByTime(5_000);
      // No state change after destroy (the 'connecting' to 'connected' already happened)
      expect(onStateChange).not.toHaveBeenCalledWith('reconnecting', expect.any(Number));
    });

    it('removes visibility listener', () => {
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
    it('closes EventSource and sets state to disconnected', () => {
      const { conn, onStateChange } = createConnection();
      conn.connect();
      const es = MockEventSource.latest();
      es.simulateOpen();

      onStateChange.mockClear();
      conn.disconnect();

      expect(es.readyState).toBe(MockEventSource.CLOSED);
      expect(conn.getState()).toBe('disconnected');
      expect(onStateChange).toHaveBeenCalledWith('disconnected', 0);
    });

    it('can reconnect after disconnect (unlike destroy)', () => {
      const { conn } = createConnection();
      conn.connect();
      MockEventSource.latest().simulateOpen();
      conn.disconnect();

      const instanceCount = MockEventSource.instances.length;
      conn.connect();
      expect(MockEventSource.instances.length).toBe(instanceCount + 1);
    });
  });

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  describe('event handlers', () => {
    it('dispatches parsed JSON data to the correct handler', () => {
      const { conn, handler } = createConnection();
      conn.connect();
      MockEventSource.latest().simulateOpen();

      MockEventSource.latest().simulateEvent('sync_update', { id: 42, name: 'test' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ id: 42, name: 'test' });
    });

    it('passes raw data when JSON parsing fails', () => {
      const rawHandler = vi.fn();
      const conn = new SSEConnection(TEST_URL, {
        eventHandlers: { raw_event: rawHandler },
        heartbeatTimeoutMs: 0,
      });
      conn.connect();
      MockEventSource.latest().simulateOpen();

      // Simulate an event with non-JSON data
      const event = new MessageEvent('raw_event', { data: 'not-json' });
      const es = MockEventSource.latest();
      // Access private listeners via the addEventListener that was called
      const listeners = (
        es as unknown as { listeners: Map<string, ((ev: MessageEvent) => void)[]> }
      ).listeners;
      for (const h of listeners.get('raw_event') ?? []) {
        h(event);
      }

      expect(rawHandler).toHaveBeenCalledWith('not-json');
    });

    it('updates lastEventAt on receiving events', () => {
      const { conn } = createConnection();
      conn.connect();
      MockEventSource.latest().simulateOpen();

      expect(conn.getLastEventAt()).toBeNull();

      vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
      MockEventSource.latest().simulateEvent('sync_update', {});

      expect(conn.getLastEventAt()).toBe(new Date('2026-01-01T00:00:05Z').getTime());
    });

    it('registers handlers for multiple event types', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const conn = new SSEConnection(TEST_URL, {
        eventHandlers: { type_a: handler1, type_b: handler2 },
        heartbeatTimeoutMs: 0,
      });
      conn.connect();
      MockEventSource.latest().simulateOpen();

      MockEventSource.latest().simulateEvent('type_a', { a: 1 });
      MockEventSource.latest().simulateEvent('type_b', { b: 2 });

      expect(handler1).toHaveBeenCalledWith({ a: 1 });
      expect(handler2).toHaveBeenCalledWith({ b: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // onStateChange callback
  // -------------------------------------------------------------------------

  describe('onStateChange callback', () => {
    it('is called with correct state and attempt count on each transition', () => {
      const { conn, onStateChange } = createConnection({ disconnectedThreshold: 2 });
      conn.connect();
      MockEventSource.latest().simulateOpen();

      expect(onStateChange).toHaveBeenCalledWith('connected', 0);

      MockEventSource.latest().simulateError();
      expect(onStateChange).toHaveBeenCalledWith('reconnecting', 1);

      vi.advanceTimersByTime(10_000);
      expect(onStateChange).toHaveBeenCalledWith('connecting', 1);

      MockEventSource.latest().simulateOpen();
      MockEventSource.latest().simulateError();
      expect(onStateChange).toHaveBeenCalledWith('disconnected', 2);
    });

    it('is not called when state does not change', () => {
      const { conn, onStateChange } = createConnection();
      // Initial state is 'connecting', calling connect() sets 'connecting' again — no-op
      conn.connect();
      // setState('connecting') is a no-op because it's already 'connecting'
      expect(onStateChange).not.toHaveBeenCalledWith('connecting', expect.any(Number));
    });
  });

  // -------------------------------------------------------------------------
  // onError callback
  // -------------------------------------------------------------------------

  describe('onError callback', () => {
    it('is called with the error event', () => {
      const { conn, onError } = createConnection();
      conn.connect();
      MockEventSource.latest().simulateOpen();
      MockEventSource.latest().simulateError();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(Event));
    });
  });

  // -------------------------------------------------------------------------
  // connect() idempotency
  // -------------------------------------------------------------------------

  describe('connect() idempotency', () => {
    it('closes existing EventSource before opening new one', () => {
      const { conn } = createConnection();
      conn.connect();
      const first = MockEventSource.latest();
      first.simulateOpen();

      conn.connect();

      expect(first.readyState).toBe(MockEventSource.CLOSED);
      expect(MockEventSource.instances.length).toBe(2);
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
});
