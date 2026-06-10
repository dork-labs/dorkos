import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectionState } from '@dorkos/shared/types';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';

import { StreamManager, type SSEConnectionLike } from '../stream-manager';
import type { SSEConnectionOptions } from '../sse-connection';

// NOTE on the testing-rule's "mock Transport via TransportProvider" wording:
// StreamManager consumes SSE frames directly (not transport.subscribeSession), so
// the correct, cleaner seam is the injected fake connection factory below. It
// satisfies the rule's intent (no real network / no fetch mocking) and lets each
// test push frames synchronously. TransportProvider is not needed for these unit
// tests.

/** A fake SSEConnection that records its options and lets the test push frames. */
class FakeConnection implements SSEConnectionLike {
  connect = vi.fn();
  disconnect = vi.fn();
  destroy = vi.fn();
  constructor(
    readonly url: string,
    readonly opts: SSEConnectionOptions
  ) {}

  /** Push a frame as the server would deliver it (event name + parsed JSON data). */
  push(eventName: string, data: unknown): void {
    this.opts.eventHandlers[eventName]?.(data);
  }

  /** Drive a connection-state change through onStateChange. */
  emitState(state: ConnectionState): void {
    this.opts.onStateChange?.(state, 0);
  }
}

/** Build a StreamManager wired to a factory that records every FakeConnection. */
function setup() {
  const connections: FakeConnection[] = [];
  const createConnection = (url: string, opts: SSEConnectionOptions): SSEConnectionLike => {
    const conn = new FakeConnection(url, opts);
    connections.push(conn);
    return conn;
  };
  const manager = new StreamManager({ createConnection });
  return { manager, connections };
}

const STATUS: SessionStatus = {
  contextUsage: null,
  cost: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
};

const SNAPSHOT: SessionSnapshot = {
  messages: [],
  inProgressTurn: null,
  status: STATUS,
  pendingInteractions: [],
  cursor: 0,
};

const TURN_START_EVENT: SessionEvent = { type: 'turn_start', seq: 1 };

describe('StreamManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT open a second connection when attachSession is called with the same id (StrictMode/HMR idempotency)', () => {
    // Real failure mode: StrictMode double-mount or an HMR cycle re-invoking
    // attachSession for the active session would otherwise open a duplicate SSE.
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    manager.attachSession('sess-a');
    expect(connections).toHaveLength(1);
    expect(connections[0]!.connect).toHaveBeenCalledTimes(1);
    expect(connections[0]!.destroy).not.toHaveBeenCalled();
  });

  it('destroys the old connection and opens a new one when attachSession re-targets to a new id', () => {
    // Real failure mode: switching the active session must re-point the stream
    // (URL is immutable per connection) without leaking the previous one.
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    manager.attachSession('sess-b');
    expect(connections).toHaveLength(2);
    expect(connections[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(connections[1]!.url).toBe('/api/sessions/sess-b/events');
    expect(connections[1]!.connect).toHaveBeenCalledTimes(1);
  });

  it('emits onSnapshot with a validated snapshot when a snapshot frame arrives', () => {
    // Real failure mode: a cold-connect snapshot frame must hydrate the store.
    const onSnapshot = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onSnapshot });
    manager.attachSession('sess-a');
    connections[0]!.push('snapshot', SNAPSHOT);
    expect(onSnapshot).toHaveBeenCalledWith('sess-a', SNAPSHOT);
  });

  it('emits onSessionEvent for a valid live event frame', () => {
    // Real failure mode: a live event frame (registered under its type name) must
    // be forwarded so the store can fold it into the projection.
    const onSessionEvent = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onSessionEvent });
    manager.attachSession('sess-a');
    connections[0]!.push('turn_start', TURN_START_EVENT);
    expect(onSessionEvent).toHaveBeenCalledWith('sess-a', TURN_START_EVENT);
  });

  it('drops a malformed frame without emitting (validation guard)', () => {
    // Real failure mode: a frame failing schema validation must be dropped, not
    // forwarded as a half-typed object that corrupts the store.
    const onSessionEvent = vi.fn();
    const onSnapshot = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager, connections } = setup();
    manager.setListeners({ onSessionEvent, onSnapshot });
    manager.attachSession('sess-a');
    // Missing required `seq` → fails SessionEventSchema.
    connections[0]!.push('turn_start', { type: 'turn_start' });
    // Garbage snapshot → fails SessionSnapshotSchema.
    connections[0]!.push('snapshot', { nope: true });
    expect(onSessionEvent).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('propagates the session connection state through onSessionConnectionState', () => {
    // Real failure mode: the UI's connection indicator depends on state changes
    // flowing through to the listener with the right session id.
    const onSessionConnectionState = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onSessionConnectionState });
    manager.attachSession('sess-a');
    connections[0]!.emitState('connected');
    expect(onSessionConnectionState).toHaveBeenCalledWith('sess-a', 'connected');
  });

  it('connectList opens the global stream once and forwards validated list events', () => {
    // Real failure mode: the global /api/events stream must be a single idempotent
    // connection that forwards session-list events for the sidebar.
    const onListEvent = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onListEvent });
    manager.connectList();
    manager.connectList(); // idempotent
    expect(connections).toHaveLength(1);
    expect(connections[0]!.url).toBe('/api/events');
    connections[0]!.push('session_removed', { type: 'session_removed', sessionId: 'sess-x' });
    expect(onListEvent).toHaveBeenCalledWith({ type: 'session_removed', sessionId: 'sess-x' });
  });

  it('detachSession destroys the active connection', () => {
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    manager.detachSession();
    expect(connections[0]!.destroy).toHaveBeenCalledTimes(1);
  });
});
