import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectionState } from '@dorkos/shared/types';
import type {
  SessionEvent,
  SessionSnapshot,
  SessionStatus,
  SessionListEvent,
} from '@dorkos/shared/session-stream';

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
  enableVisibilityOptimization = vi.fn();
  constructor(
    readonly url: string,
    readonly opts: SSEConnectionOptions
  ) {}

  /** Push a frame as the server would deliver it (event name + parsed JSON data). */
  push(eventName: string, data: unknown): void {
    this.opts.eventHandlers[eventName]?.(data);
  }

  /** Drive a connection-state change through onStateChange. */
  emitState(state: ConnectionState, failedAttempts = 0): void {
    this.opts.onStateChange?.(state, failedAttempts);
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

  it('dispatches a ui_command frame to subscribers AND forwards it to the store', () => {
    // Real failure mode (DOR-104): a `control_ui` event must reach both the store
    // (so the seq watermark advances) and the UI-command subscriber (the side
    // effect, e.g. open the canvas) — otherwise the agent canvas is a silent no-op.
    const onSessionEvent = vi.fn();
    const onUiCommand = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onSessionEvent });
    manager.subscribeUiCommand(onUiCommand);
    manager.attachSession('sess-a');
    const command = { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } };
    const event: SessionEvent = { type: 'ui_command', seq: 2, command } as SessionEvent;
    connections[0]!.push('ui_command', event);
    expect(onUiCommand).toHaveBeenCalledWith(command);
    expect(onSessionEvent).toHaveBeenCalledWith('sess-a', event);
  });

  it('does NOT dispatch a ui_command from a non-attached (background) session', () => {
    // Real failure mode: a background agent must not pop UI over the session the
    // operator is watching. The dispatch is gated to the attached session.
    const onUiCommand = vi.fn();
    const { manager, connections } = setup();
    manager.subscribeUiCommand(onUiCommand);
    manager.attachSession('sess-a');
    manager.attachSession('sess-b'); // re-target: sess-a's connection still exists
    const event: SessionEvent = {
      type: 'ui_command',
      seq: 2,
      command: { action: 'close_canvas' },
    } as SessionEvent;
    // Push on sess-a's (now-background) connection — its eventHandlers still fire.
    connections[0]!.push('ui_command', event);
    expect(onUiCommand).not.toHaveBeenCalled();
  });

  it('unsubscribeUiCommand stops further dispatch', () => {
    const onUiCommand = vi.fn();
    const { manager, connections } = setup();
    const unsubscribe = manager.subscribeUiCommand(onUiCommand);
    manager.attachSession('sess-a');
    unsubscribe();
    const event: SessionEvent = {
      type: 'ui_command',
      seq: 2,
      command: { action: 'close_canvas' },
    } as SessionEvent;
    connections[0]!.push('ui_command', event);
    expect(onUiCommand).not.toHaveBeenCalled();
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

describe('StreamManager — HTTP source (baseUrl)', () => {
  it('builds stream URLs from the configured base URL (packaged Electron)', () => {
    // Real failure mode: a file:// renderer cannot resolve a relative /api —
    // the streams must use the same absolute origin as HttpTransport.
    const { manager, connections } = setup();
    manager.useHttpSource('http://localhost:4242/api');
    manager.attachSession('sess-a', '/proj');
    manager.connectList();
    expect(connections[0]!.url).toBe(
      'http://localhost:4242/api/sessions/sess-a/events?cwd=%2Fproj'
    );
    expect(connections[1]!.url).toBe('http://localhost:4242/api/events');
  });

  it('re-opens live streams against the new base URL when the source switches', () => {
    // Real failure mode: a late source switch silently killing (or keeping)
    // streams on the previous origin.
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    manager.connectList();
    manager.useHttpSource('http://localhost:9999/api');
    expect(connections[0]!.destroy).toHaveBeenCalled();
    expect(connections[1]!.destroy).toHaveBeenCalled();
    const urls = connections.slice(2).map((c) => c.url);
    expect(urls).toContain('http://localhost:9999/api/sessions/sess-a/events');
    expect(urls).toContain('http://localhost:9999/api/events');
  });
});

describe('StreamManager — Transport source (embedded pump)', () => {
  /** A fake Transport stream seam with controllable in-process iterables. */
  function fakeTransport(opts: {
    events?: SessionEvent[];
    listEvents?: unknown[];
    snapshot?: SessionSnapshot;
  }) {
    const captured: { signal?: AbortSignal } = {};
    return {
      captured,
      getSessionSnapshot: vi.fn(async () => opts.snapshot ?? SNAPSHOT),
      subscribeSession: vi.fn(function (
        _id: string,
        _cursor?: number,
        _cwd?: string,
        signal?: AbortSignal
      ) {
        captured.signal = signal;
        return (async function* () {
          for (const event of opts.events ?? []) yield event;
          // Park until aborted, like a live in-process stream between turns.
          await new Promise<void>((resolve) => {
            if (!signal) return resolve();
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        })();
      }),
      subscribeSessionList: vi.fn(async function* (): AsyncGenerator<SessionListEvent> {
        for (const event of (opts.listEvents ?? []) as SessionListEvent[]) yield event;
      }),
    };
  }

  it('pumps snapshot → connected → live events through the same listener fan-out', async () => {
    // Real failure mode: embedded mode (no HTTP server) must hydrate and
    // stream through the Transport seam, or Obsidian chat renders nothing.
    const onSnapshot = vi.fn();
    const onSessionEvent = vi.fn();
    const onSessionConnectionState = vi.fn();
    const { manager } = setup();
    const transport = fakeTransport({ events: [TURN_START_EVENT] });
    manager.useTransportSource(transport);
    manager.setListeners({ onSnapshot, onSessionEvent, onSessionConnectionState });
    manager.attachSession('sess-a', '/proj');

    await vi.waitFor(() => {
      expect(onSessionEvent).toHaveBeenCalledWith('sess-a', TURN_START_EVENT);
    });
    expect(onSnapshot).toHaveBeenCalledWith('sess-a', SNAPSHOT);
    expect(onSessionConnectionState).toHaveBeenCalledWith('sess-a', 'connecting');
    expect(onSessionConnectionState).toHaveBeenCalledWith('sess-a', 'connected');
    // Subscribed from the snapshot's cursor so no event is missed in between.
    expect(transport.subscribeSession).toHaveBeenCalledWith(
      'sess-a',
      SNAPSHOT.cursor,
      '/proj',
      expect.any(AbortSignal)
    );
  });

  it('aborts the in-process subscription when the session detaches', async () => {
    // Real failure mode: a parked embedded generator survives a session switch
    // (a bare iterator.return() cannot interrupt it) — the signal must fire.
    const { manager } = setup();
    const transport = fakeTransport({});
    manager.useTransportSource(transport);
    manager.attachSession('sess-a');
    await vi.waitFor(() => {
      expect(transport.captured.signal).toBeDefined();
    });

    manager.detachSession();

    expect(transport.captured.signal!.aborted).toBe(true);
  });

  it('pumps validated session-list events from the transport', async () => {
    const onListEvent = vi.fn();
    const { manager } = setup();
    const listEvent = { type: 'session_removed', sessionId: 'sess-x' };
    const transport = fakeTransport({ listEvents: [listEvent] });
    manager.useTransportSource(transport);
    manager.setListeners({ onListEvent });
    manager.connectList();

    await vi.waitFor(() => {
      expect(onListEvent).toHaveBeenCalledWith(listEvent);
    });
  });

  it('closes a PARKED list iterable on disconnectList via iterator.return()', () => {
    // Real failure mode (review finding): the list stream has no abort signal,
    // so iterator.return() is the ONLY teardown — if it parks behind a pending
    // next() (e.g. a delegating-generator wrapper), the runtime's directory
    // watcher leaks on every view reopen.
    let returned = false;
    const parked = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<never>(() => {}),
          return: () => {
            returned = true;
            return Promise.resolve({ value: undefined, done: true as const });
          },
        };
      },
    };
    const { manager } = setup();
    const transport = fakeTransport({});
    transport.subscribeSessionList.mockImplementation(
      () => parked as unknown as AsyncGenerator<SessionListEvent>
    );
    manager.useTransportSource(transport);
    manager.connectList();

    manager.disconnectList();

    expect(returned).toBe(true);
  });

  it('re-attaches an active session through the pump when the source switches to transport', async () => {
    // Real failure mode: switching source while a session is attached must
    // re-open the stream from the new source, not silently kill it.
    const onSnapshot = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onSnapshot });
    manager.attachSession('sess-a', '/proj');
    const transport = fakeTransport({});

    manager.useTransportSource(transport);

    expect(connections[0]!.destroy).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(transport.getSessionSnapshot).toHaveBeenCalledWith('sess-a', '/proj');
    });
    await vi.waitFor(() => {
      expect(onSnapshot).toHaveBeenCalledWith('sess-a', SNAPSHOT);
    });
  });

  it('configuring an identical source is a no-op (StrictMode/HMR churn guard)', () => {
    const { manager, connections } = setup();
    manager.useHttpSource('/api');
    manager.attachSession('sess-a');
    manager.useHttpSource('/api');
    expect(connections).toHaveLength(1);
    expect(connections[0]!.destroy).not.toHaveBeenCalled();
  });

  it('still validates pumped frames — malformed events are dropped', async () => {
    // Real failure mode: embedded mode skipping validation would let a buggy
    // runtime corrupt the store where HTTP mode would have dropped the frame.
    const onSessionEvent = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager } = setup();
    const transport = fakeTransport({
      events: [{ type: 'turn_start' } as SessionEvent, TURN_START_EVENT],
    });
    manager.useTransportSource(transport);
    manager.setListeners({ onSessionEvent });
    manager.attachSession('sess-a');

    await vi.waitFor(() => {
      expect(onSessionEvent).toHaveBeenCalledWith('sess-a', TURN_START_EVENT);
    });
    expect(onSessionEvent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('StreamManager — unified global stream (CLI-B5)', () => {
  it('dispatches generic events from the LIST connection to subscribeEvent subscribers', () => {
    // Real failure mode: tunnel/relay/extension consumers used to open a THIRD
    // /api/events connection; they must now ride the list connection.
    const { manager, connections } = setup();
    const handler = vi.fn();
    manager.subscribeEvent('tunnel_status', handler); // subscribed BEFORE connect
    manager.connectList();
    expect(connections).toHaveLength(1);
    connections[0]!.push('tunnel_status', { connected: true });
    expect(handler).toHaveBeenCalledWith({ connected: true });
  });

  it('generic dispatch does not interfere with session-list event forwarding', () => {
    const onListEvent = vi.fn();
    const handler = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onListEvent });
    manager.connectList();
    manager.subscribeEvent('relay_message', handler); // subscribed AFTER connect
    const removed: SessionListEvent = { type: 'session_removed', sessionId: 'sess-a' };
    connections[0]!.push('session_removed', removed);
    connections[0]!.push('relay_message', { id: 'm1' });
    expect(onListEvent).toHaveBeenCalledWith(removed);
    expect(handler).toHaveBeenCalledWith({ id: 'm1' });
  });

  it('unsubscribing a generic handler stops dispatch', () => {
    const { manager, connections } = setup();
    const handler = vi.fn();
    const unsubscribe = manager.subscribeEvent('extension_reloaded', handler);
    manager.connectList();
    unsubscribe();
    connections[0]!.push('extension_reloaded', { extensionIds: ['a'] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('tracks and publishes the list connection state (incl. failed attempts)', () => {
    const { manager, connections } = setup();
    const listener = vi.fn();
    manager.subscribeListConnectionState(listener);
    manager.connectList();
    connections[0]!.emitState('connected');
    expect(manager.getListConnectionState()).toBe('connected');
    expect(listener).toHaveBeenCalledWith('connected', 0);
    connections[0]!.emitState('reconnecting', 2);
    expect(manager.getListConnectionState()).toBe('reconnecting');
    expect(manager.getListFailedAttempts()).toBe(2);
    expect(listener).toHaveBeenLastCalledWith('reconnecting', 2);
  });

  it('enables visibility optimization on the list connection (hidden-tab release)', () => {
    const { manager, connections } = setup();
    manager.connectList();
    expect(connections[0]!.enableVisibilityOptimization).toHaveBeenCalledTimes(1);
  });

  it('getAttachedSessionId reflects the active-session attach lifecycle', () => {
    const { manager } = setup();
    expect(manager.getAttachedSessionId()).toBeNull();
    manager.attachSession('sess-a');
    expect(manager.getAttachedSessionId()).toBe('sess-a');
    manager.detachSession();
    expect(manager.getAttachedSessionId()).toBeNull();
  });
});
