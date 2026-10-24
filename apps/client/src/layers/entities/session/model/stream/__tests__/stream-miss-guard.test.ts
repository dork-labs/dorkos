/**
 * The open chat's live stream missed a turn the server ran: the window must
 * notice, say so to the server, and rebuild the stream from a fresh snapshot.
 *
 * The real case (2026-10-18): a long chat whose turns were mostly started by
 * other agents' messages sat idle for two hours. The server evicted the session
 * and the window's stream went on reading a feed nothing wrote to any more. The
 * person's next prompt ran and finished on the server; the global stream said
 * so; the chat itself showed no working indicator and no reply until a refresh.
 *
 * Driven through the binding's real listeners and a fake-backed StreamManager,
 * the same seam `session-stream-binding.test.ts` uses, so a list frame travels
 * list connection → StreamManager → binding → guard → recover → new session
 * connection, with no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';
import {
  StreamManager,
  streamManager,
  type DurableStreamConnection,
  type StreamConnectionOptions,
  type StreamManagerListeners,
} from '@/layers/shared/lib/transport';

import { initSessionStreamBinding, resetSessionStreamBinding } from '../session-stream-binding';
import { useSessionStreamStore } from '../session-stream-store';
import { useSessionListStore } from '../session-list-store';
import {
  HEARD_SLACK_MS,
  SETTLE_GRACE_MS,
  SILENT_TURN_MS,
  resetStreamMissGuard,
} from '../stream-miss-guard';

const SESSION = 'cody-direct-chat';

class FakeConnection implements DurableStreamConnection {
  connect = vi.fn();
  disconnect = vi.fn();
  destroy = vi.fn();
  constructor(
    readonly url: string,
    readonly opts: StreamConnectionOptions
  ) {}
  push(eventName: string, data: unknown): void {
    this.opts.eventHandlers[eventName]?.(data);
  }
  emitState(state: Parameters<NonNullable<StreamConnectionOptions['onStateChange']>>[0]): void {
    this.opts.onStateChange?.(state, 0);
  }
}

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

describe('the stream-miss guard', () => {
  let manager: StreamManager;
  let sessionConnections: FakeConnection[];
  let listConnection: FakeConnection;
  let fetchMock: ReturnType<typeof vi.fn>;

  /** The global stream announcing this chat's lifecycle. */
  function announce(lifecycle: SessionStatus['lifecycle']): void {
    listConnection.push('session_status', {
      type: 'session_status',
      sessionId: SESSION,
      status: { ...STATUS, lifecycle },
    });
  }

  /** The chat's own stream delivering one event on its newest connection. */
  function deliver(event: SessionEvent): void {
    sessionConnections.at(-1)!.push(event.type, event);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    resetStreamMissGuard();
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({
      sessions: {},
      statuses: {},
      statusCwds: {},
      unseen: {},
      rekeys: {},
    });
    resetSessionStreamBinding();

    let installed: StreamManagerListeners = {};
    vi.spyOn(streamManager, 'setListeners').mockImplementation((l) => {
      installed = l;
    });
    vi.spyOn(streamManager, 'subscribeListConnectionState').mockImplementation(() => () => {});
    initSessionStreamBinding();

    sessionConnections = [];
    manager = new StreamManager({
      createConnection: (url, opts) => {
        const conn = new FakeConnection(url, opts);
        if (url.endsWith('/events') && !url.includes('/sessions/')) listConnection = conn;
        else sessionConnections.push(conn);
        return conn;
      },
    });
    manager.setListeners(installed);
    // The guard reads the app's singleton; point it at this window's manager.
    vi.spyOn(streamManager, 'getAttachedSessionId').mockImplementation(() =>
      manager.getAttachedSessionId()
    );
    vi.spyOn(streamManager, 'recoverSession').mockImplementation((id, report) =>
      manager.recoverSession(id, report)
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    manager.connectList();
    manager.attachSession(SESSION);
    sessionConnections[0]!.emitState('connected');
    sessionConnections[0]!.push('snapshot', SNAPSHOT);
  });

  afterEach(() => {
    resetStreamMissGuard();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** The stream-health reports this window sent, parsed. */
  function reports(): Array<{ kind: string; connectionState: string }> {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(`/sessions/${SESSION}/stream-health`))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
  }

  it('leaves a working stream alone, however long a tool call runs', () => {
    // A turn another agent's message started, heard live by the window.
    announce('streaming');
    deliver({ type: 'turn_start', seq: 1 });
    deliver({ type: 'tool_call', seq: 2, toolCallId: 't1', toolName: 'Bash', status: 'running' });
    vi.advanceTimersByTime(SILENT_TURN_MS * 5);
    deliver({ type: 'turn_end', seq: 3 });
    announce('idle');
    vi.advanceTimersByTime(SETTLE_GRACE_MS * 2);

    expect(sessionConnections).toHaveLength(1);
    expect(reports()).toEqual([]);
  });

  it('rebuilds a stream that stays silent through a running turn, and reports it', () => {
    // The agent-started turn streams fine…
    announce('streaming');
    deliver({ type: 'turn_start', seq: 1 });
    deliver({ type: 'turn_end', seq: 2 });
    announce('idle');
    vi.advanceTimersByTime(HEARD_SLACK_MS * 30);

    // …then the person's queued prompt runs, and the chat's stream hears nothing.
    announce('streaming');
    vi.advanceTimersByTime(SILENT_TURN_MS - 1);
    expect(sessionConnections).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(sessionConnections).toHaveLength(2);
    expect(sessionConnections[0]!.destroy).toHaveBeenCalled();
    expect(sessionConnections[1]!.connect).toHaveBeenCalled();
    expect(reports()).toEqual([expect.objectContaining({ kind: 'silent-turn' })]);

    // The fresh snapshot carries the turn in progress: the indicator comes back.
    sessionConnections[1]!.push('snapshot', {
      ...SNAPSHOT,
      status: { ...STATUS, lifecycle: 'streaming' },
      inProgressTurn: [{ type: 'turn_start', seq: 1 }],
      cursor: 1,
    });
    expect(useSessionStreamStore.getState().getSession(SESSION).status?.lifecycle).toBe(
      'streaming'
    );
    // One miss, one report: the settle that follows does not report it again.
    announce('idle');
    vi.advanceTimersByTime(SETTLE_GRACE_MS);
    expect(reports()).toHaveLength(1);
  });

  it('rebuilds a stream that missed a whole short turn, and reports it', () => {
    vi.advanceTimersByTime(HEARD_SLACK_MS * 30);
    announce('streaming');
    vi.advanceTimersByTime(8_000);
    announce('idle');
    vi.advanceTimersByTime(SETTLE_GRACE_MS);

    expect(sessionConnections).toHaveLength(2);
    expect(reports()).toEqual([expect.objectContaining({ kind: 'unrendered-turn' })]);
  });

  it('ignores turns on chats this window is not showing', () => {
    vi.advanceTimersByTime(HEARD_SLACK_MS * 30);
    listConnection.push('session_status', {
      type: 'session_status',
      sessionId: 'some-other-chat',
      status: { ...STATUS, lifecycle: 'streaming' },
    });
    vi.advanceTimersByTime(SILENT_TURN_MS * 2);

    expect(sessionConnections).toHaveLength(1);
    expect(reports()).toEqual([]);
  });
});
