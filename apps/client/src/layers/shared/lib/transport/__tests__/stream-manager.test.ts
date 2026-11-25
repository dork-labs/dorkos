// @vitest-environment jsdom
import { CanvasChannelNotificationSchema } from '@dorkos/shared/canvas-channel-schemas';
import { subscribeDocChannelNotifications } from '../doc-channel-notifications';
import { DOC_EVENT, DOC_SNAPSHOT } from './doc-channel-fixtures';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SessionEventSchema,
  SessionListEventSchema,
  type SessionEvent,
  type SessionSnapshot,
  type SessionStatus,
} from '@dorkos/shared/session-stream';
import { createMockTransport } from '@dorkos/test-utils';
import { GENERIC_EVENTS } from '../generic-events';
import { setup, transportOwner } from './stream-manager.fixtures';

const STATUS: SessionStatus = {
  contextUsage: null,
  cost: null,
  usage: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
  lastError: null,
  limit: null,
  accountUsage: null,
};

const SNAPSHOT: SessionSnapshot = {
  messages: [],
  inProgressTurn: null,
  status: STATUS,
  pendingInteractions: [],
  queuedMessages: [],
  canvas: [],
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

  it('revives a session stream that gave up when the same session is attached again', () => {
    // Real failure mode: a laptop waking without a network spends the five reconnect attempts in
    // seconds and the stream settles at `disconnected`, where it never retries.
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    connections[0]!.emitState('disconnected');

    manager.attachSession('sess-a'); // the next send re-attaches the same chat

    expect(connections).toHaveLength(2);
    expect(connections[0]!.destroy).toHaveBeenCalled();
    expect(connections[1]!.url).toBe('/api/sessions/sess-a/events');
    expect(connections[1]!.connect).toHaveBeenCalledTimes(1);
    expect(manager.getAttachedSessionId()).toBe('sess-a');
  });

  it("tells each chat's stream which chat it is for, and leaves the list stream unchecked (DOR-4552)", () => {
    // The socket drops a frame named for another chat only when it knows its own.
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    manager.pinSession('sess-b');
    manager.connectList();

    const byUrl = (url: string) => connections.find((c) => c.url === url)!.opts.resourceId;
    expect(byUrl('/api/sessions/sess-a/events')).toBe('sess-a');
    expect(byUrl('/api/sessions/sess-b/events')).toBe('sess-b');
    expect(byUrl('/api/events')).toBeUndefined();
  });

  it('recoverSession reports the miss and rebuilds only the attached session', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    connections[0]!.emitState('connected');

    manager.recoverSession('sess-b', { kind: 'silent-turn', silentMs: 20_000, lastSeq: 4 });
    expect(connections).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();

    manager.recoverSession('sess-a', { kind: 'silent-turn', silentMs: 20_000, lastSeq: 4 });
    expect(connections).toHaveLength(2);
    expect(connections[0]!.destroy).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/sess-a/stream-health',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      kind: 'silent-turn',
      silentMs: 20_000,
      lastSeq: 4,
      connectionState: 'connected',
    });
    vi.unstubAllGlobals();
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
    // Real failure mode (DOR-104): a `control_ui` event must reach both the store (so the seq
    // watermark advances) and the UI-command subscriber (the side effect, e.g. open the canvas) —
    // otherwise the agent canvas is a silent no-op.
    const onSessionEvent = vi.fn();
    const onUiCommand = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onSessionEvent });
    manager.subscribeUiCommand(onUiCommand);
    manager.attachSession('sess-a');
    const command = { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } };
    const event: SessionEvent = { type: 'ui_command', seq: 2, command } as SessionEvent;
    connections[0]!.push('ui_command', event);
    // The subscriber receives the command AND the attached session id, so
    // session-scoped commands (e.g. open_pip) know which session issued them.
    expect(onUiCommand).toHaveBeenCalledWith(command, 'sess-a');
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

  it('hydrates a snapshot with one unreadable message, showing a placeholder in its place (DOR-2078)', () => {
    // Real failure mode: one malformed field anywhere in history dropped the
    // whole snapshot frame and the session never loaded ("Session not found").
    const onSnapshot = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager, connections } = setup();
    manager.setListeners({ onSnapshot });
    manager.attachSession('sess-a');
    const frame = {
      ...SNAPSHOT,
      messages: [
        { id: 'm1', role: 'user', content: 'Hello' },
        { id: 'm2', role: 'assistant', content: 'x', parts: [{ type: 'tool_call' }] },
        { id: 'm3', role: 'assistant', content: 'Done' },
      ],
    };

    connections[0]!.push('snapshot', frame);
    // A reconnect re-delivers the same history: it must hydrate again, but the
    // defect is only logged once for the session.
    connections[0]!.push('snapshot', frame);

    expect(onSnapshot).toHaveBeenCalledTimes(2);
    const snapshot = onSnapshot.mock.calls[0]![1] as SessionSnapshot;
    expect(snapshot.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(snapshot.messages[1]!.parts).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('couldn’t be shown'),
        code: 'unreadable_entry',
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      sessionId: 'sess-a',
      unreadable: [expect.objectContaining({ path: expect.stringMatching(/^messages\.1\./) })],
    });
    warn.mockRestore();
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

  it('registers a frame handler for EVERY SessionEventSchema discriminant (schema-drift pin)', () => {
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    const registered = Object.keys(connections[0]!.opts.eventHandlers);
    const discriminants = SessionEventSchema.options.map(
      (option) => (option.shape.type as { value: string }).value
    );
    expect(discriminants.length).toBeGreaterThan(0);
    for (const type of discriminants) {
      expect(
        registered,
        `no handler registered for '${type}' — it would be silently dropped`
      ).toContain(type);
    }
    // Document notifications are a separate wire family, never transcript events.
    const documentTypes = CanvasChannelNotificationSchema.options.map(
      (option) => option.shape.type.value
    );
    expect([...registered].sort()).toEqual([...discriminants, ...documentTypes, 'snapshot'].sort());
  });

  it('registers a frame handler for EVERY SessionListEventSchema discriminant (schema-drift pin)', () => {
    // Real failure mode, and the exact one the sibling pin above exists for, on
    // `SESSION_LIST_EVENT_TYPES` (declared once in `session-stream-methods.ts` and imported here,
    // DOR-576): it is the gate every session-list event the shipped web/Electron/CLI client
    // receives over HTTP passes through.
    const { manager, connections } = setup();
    manager.connectList();
    const handlers = connections[0]!.opts.eventHandlers;
    const registered = Object.keys(handlers);
    const discriminants = SessionListEventSchema.options.map(
      (option) => (option.shape.type as { value: string }).value
    );
    expect(discriminants.length).toBeGreaterThan(0);

    // Forward: every discriminant the schema declares has a listener.
    for (const type of discriminants) {
      expect(
        registered,
        `no handler registered for '${type}' — EventSource would silently drop the frame`
      ).toContain(type);
    }

    // Reverse: no name in the allowlist that the schema no longer declares.
    const listHandler = handlers[discriminants[0]!];
    const listNames = registered.filter((name) => handlers[name] === listHandler);
    expect(
      [...listNames].sort(),
      'SESSION_LIST_EVENT_TYPES names something SessionListEventSchema does not declare. ' +
        'A name that outlived its discriminant registers a listener for frames the server ' +
        'can no longer send, which reads as coverage and is not.'
    ).toEqual([...discriminants].sort());

    // Guards the guard: if the two lists ever went disjoint, the identity
    // partition above would compare an empty set against an empty set.
    expect(listNames.length).toBeGreaterThan(0);
    // And the generic names really are in the same map, which is what makes the
    // identity comparison necessary rather than decorative.
    expect(registered).toContain(GENERIC_EVENTS[0]);
  });

  it('detachSession destroys the active connection', () => {
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    manager.detachSession();
    expect(connections[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it('announces connecting when a session stream opens, over the last stream’s state', () => {
    // DOR-1916: a fresh connection starts at `connecting` and only announces a
    // change, so the store kept session A's `disconnected` across a switch away
    // and back and showed "Live updates lost" over a healthy connect.
    const onSessionConnectionState = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onSessionConnectionState });
    manager.attachSession('sess-a');
    connections[0]!.emitState('disconnected');
    manager.attachSession('sess-b');

    onSessionConnectionState.mockClear();
    manager.attachSession('sess-a');

    // Before the new socket says anything, sess-a already reads `connecting`.
    const forA = onSessionConnectionState.mock.calls.filter(([id]) => id === 'sess-a');
    expect(forA.at(-1)).toEqual(['sess-a', 'connecting']);
  });
});

describe('StreamManager — HTTP source (baseUrl)', () => {
  it('re-opens live streams against the new base URL when the source switches', () => {
    // Real failure mode: a late source switch silently killing (or keeping)
    // streams on the previous origin.
    const { manager, connections } = setup();
    manager.attachSession('sess-a');
    manager.connectList();
    manager.useHttpSource('http://localhost:9999/api', transportOwner);
    expect(connections[0]!.destroy).toHaveBeenCalled();
    expect(connections[1]!.destroy).toHaveBeenCalled();
    const urls = connections.slice(2).map((c) => c.url);
    expect(urls).toContain('http://localhost:9999/api/sessions/sess-a/events');
    expect(urls).toContain('http://localhost:9999/api/events');
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

  // --- Extension event bridge taps (subscribeSessionEvent / subscribeListEvent /
  //     subscribeAttachedSessionChange) ---

  it('forwards attached-session events to subscribeSessionEvent listeners', () => {
    const { manager, connections } = setup();
    const handler = vi.fn();
    manager.subscribeSessionEvent(handler);
    manager.attachSession('sess-a');
    connections[0]!.push('turn_start', { type: 'turn_start', seq: 1 });
    expect(handler).toHaveBeenCalledWith('sess-a', { type: 'turn_start', seq: 1 });
  });

  it('emits a single attach transition per switch (no null flicker on re-attach)', () => {
    const { manager } = setup();
    const handler = vi.fn();
    manager.subscribeAttachedSessionChange(handler);

    manager.attachSession('sess-a');
    manager.attachSession('sess-b');

    expect(handler.mock.calls).toEqual([
      ['sess-a', null],
      ['sess-b', 'sess-a'],
    ]);
  });

  it('does not emit attach transitions on a source switch (no A→null→A flicker)', () => {
    const { manager, connections } = setup();
    const handler = vi.fn();
    manager.subscribeAttachedSessionChange(handler);
    manager.attachSession('sess-a');
    expect(handler).toHaveBeenCalledTimes(1);

    manager.useHttpSource('http://localhost:4242/api', transportOwner);

    // The session stays attached, a fresh connection opened against the new
    // source, and no extra transition fired.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(manager.getAttachedSessionId()).toBe('sess-a');
    expect(connections).toHaveLength(2);
    expect(connections[0]!.destroy).toHaveBeenCalled();
    expect(connections[1]!.url).toContain('http://localhost:4242/api');
    expect(connections[1]!.connect).toHaveBeenCalledTimes(1);
  });
});

it('routes document frames separately from transcript taps without opening another connection', () => {
  const { manager, connections } = setup();
  const transcript = vi.fn();
  const tap = vi.fn();
  const docs = vi.fn();
  const stop = subscribeDocChannelNotifications(undefined, docs);
  manager.setListeners({ onSessionEvent: transcript });
  manager.subscribeSessionEvent(tap);
  manager.attachSession('request-alias');
  try {
    connections[0]!.push('canvas_event', DOC_EVENT);
    connections[0]!.push('canvas_channel_snapshot', DOC_SNAPSHOT);
    connections[0]!.push('canvas_event', { ...DOC_EVENT, docSeq: -1 });
    expect(docs.mock.calls.map(([frame]) => frame)).toEqual([DOC_EVENT, DOC_SNAPSHOT]);
    expect(transcript).not.toHaveBeenCalled();
    expect(tap).not.toHaveBeenCalled();
    connections[0]!.push('turn_start', TURN_START_EVENT);
    expect(transcript).toHaveBeenCalledWith('request-alias', TURN_START_EVENT);
    expect(connections).toHaveLength(1);
  } finally {
    stop();
    manager.detachSession();
  }
});

it('changes owner even at the same URL and refuses the retired connection after callback reentry', () => {
  const { manager, connections } = setup();
  manager.attachSession('A');
  const old = connections[0]!;
  const first = vi.fn();
  const later = vi.fn();
  const replacement = createMockTransport();
  const stops = [
    subscribeDocChannelNotifications(
      undefined,
      () => {
        first();
        manager.useHttpSource('/api', replacement);
      },
      transportOwner
    ),
    subscribeDocChannelNotifications(undefined, later, transportOwner),
  ];
  try {
    old.push('canvas_event', DOC_EVENT);
    expect(first).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
    expect(old.destroy).toHaveBeenCalledOnce();
    expect(connections).toHaveLength(2);
    old.push('canvas_event', DOC_EVENT);
    expect(first).toHaveBeenCalledOnce();
    const current = vi.fn();
    const stop = subscribeDocChannelNotifications(undefined, current, replacement);
    try {
      connections[1]!.push('canvas_event', DOC_EVENT);
      expect(current).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  } finally {
    stops.forEach((stop) => stop());
    manager.detachSession();
  }
});

it('physically destroys a genuine session connection and drains retirement after a subscriber throws', () => {
  const { manager, connections } = setup();
  manager.attachSession('A');
  const old = connections[0]!;
  const sibling = vi.fn();
  const events = vi.fn();
  const stops = [
    subscribeDocChannelNotifications(undefined, vi.fn(), transportOwner, () => {
      throw new Error('Retirement subscriber');
    }),
    subscribeDocChannelNotifications(undefined, events, transportOwner, sibling),
  ];
  try {
    manager.detachSession();
    expect(sibling).toHaveBeenCalledOnce();
    expect(old.destroy).toHaveBeenCalledOnce();
    old.push('canvas_event', DOC_EVENT);
    expect(events).not.toHaveBeenCalled();
    expect(manager.getAttachedSessionId()).toBeNull();
  } finally {
    stops.forEach((stop) => stop());
    manager.detachSession();
  }
});
