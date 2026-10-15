import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConnectionState } from '@dorkos/shared/types';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';
import {
  StreamManager,
  streamManager,
  type DurableStreamConnection,
  type StreamManagerListeners,
} from '@/layers/shared/lib/transport';
import type { StreamConnectionOptions } from '@/layers/shared/lib/transport';
import {
  buildUiStateSnapshot,
  prepareUiStateForSend,
  clearUiStateSendCache,
} from '@/layers/shared/lib';

import { useAppStore } from '@/layers/shared/model';

import { initSessionStreamBinding, resetSessionStreamBinding } from '../session-stream-binding';
import { useSessionStreamStore } from '../session-stream-store';
import { useSessionListStore } from '../session-list-store';
import {
  predatesSessionListReset,
  resetSessionListResetMarker,
} from '../../../lib/session-list-reset';

// End-to-end wiring test: prove that driving a StreamManager's (fake) connection
// results in the stores being updated through the binding's real listener object.
// We capture the listeners the binding installs on the singleton, then replay
// them through a fake-backed StreamManager so a pushed frame travels the full
// path (connection → StreamManager → binding listener → store) with no real
// network — the injected-fake-connection seam (see stream-manager.test.ts note).

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

const UI_SNAPSHOT = buildUiStateSnapshot(
  {
    settingsOpen: false,
    tasksOpen: false,
    relayOpen: false,
    pickerOpen: false,
    sidebarOpen: true,
  },
  '/projects/app'
);

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
  messages: [{ id: 'm1', role: 'user', content: 'hi' }],
  inProgressTurn: null,
  status: STATUS,
  pendingInteractions: [],
  queuedMessages: [],
  canvas: [],
  cursor: 0,
};

describe('initSessionStreamBinding', () => {
  let installed: StreamManagerListeners;
  let manager: StreamManager;
  let connections: FakeConnection[];
  let listStateListener: ((state: ConnectionState, failedAttempts: number) => void) | undefined;

  beforeEach(() => {
    // Restore singleton spies from the PREVIOUS test first — e.g. a mocked
    // getAttachedSessionId must not leak into tests that rely on the real
    // (null) value, and re-spying setListeners must not stack wrappers.
    vi.restoreAllMocks();
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({
      sessions: {},
      statuses: {},
      statusCwds: {},
      unseen: {},
      rekeys: {},
    });
    resetSessionStreamBinding();

    // Capture the real listener object the binding installs on the singleton,
    // and the connection-state listener it registers for the re-baseline.
    installed = {};
    vi.spyOn(streamManager, 'setListeners').mockImplementation((l) => {
      installed = l;
    });
    listStateListener = undefined;
    vi.spyOn(streamManager, 'subscribeListConnectionState').mockImplementation((l) => {
      listStateListener = l;
      return () => {};
    });
    initSessionStreamBinding();

    // Replay those listeners through a fake-backed StreamManager.
    connections = [];
    manager = new StreamManager({
      createConnection: (url, opts) => {
        const conn = new FakeConnection(url, opts);
        connections.push(conn);
        return conn;
      },
    });
    manager.setListeners(installed);
  });

  it('dispatches a snapshot frame into the per-session stream store', () => {
    manager.attachSession('sess-1');
    connections[0]!.push('snapshot', SNAPSHOT);
    expect(useSessionStreamStore.getState().getSession('sess-1').messages).toHaveLength(1);
    expect(useSessionStreamStore.getState().getSession('sess-1').streamReadyCursor).toBe(0);
  });

  it('dispatches a session event into the per-session stream store', () => {
    manager.attachSession('sess-1');
    connections[0]!.push('snapshot', SNAPSHOT);
    const event: SessionEvent = { type: 'turn_start', seq: 1 };
    connections[0]!.push('turn_start', event);
    expect(useSessionStreamStore.getState().getSession('sess-1').lastAppliedSeq).toBe(1);
  });

  it('dispatches the capability-approval hold pair into the in-progress turn (inline approval card)', () => {
    // Real failure mode (DOR-963): the in-session capability hold (DOR-939) is
    // rendered from `inProgressTurn` — `projectInProgressTurn` folds
    // `capability_approval_required` into an inline `capability_approval` card
    // and `capability_approval_resolved` retires it. Both halves reach that
    // array ONLY if StreamManager registers a frame handler under each name;
    // the socket drops an unregistered name in silence, so a missing entry
    // means the operator is never asked and the agent's held call just waits
    // out its cap. This drives the whole path with no network: frame →
    // StreamManager → binding listener → store.
    manager.attachSession('sess-1');
    connections[0]!.push('snapshot', SNAPSHOT);

    const held: SessionEvent = {
      type: 'capability_approval_required',
      seq: 1,
      startedAt: 1_000_000,
      capMs: 45_000,
      approval: {
        approvalId: 'appr-1',
        capabilityId: 'mcp.add',
        capabilityTitle: 'Add an MCP server',
        tier: 'destructive',
        summary: 'Prober wants to run "Add an MCP server"',
        hasAgentPath: true,
        area: null,
        alwaysOffered: false,
        requestedAt: '2026-08-06T00:00:00.000Z',
        expiresAt: '2026-08-06T02:00:00.000Z',
      },
    };
    connections[0]!.push('capability_approval_required', held);
    expect(useSessionStreamStore.getState().getSession('sess-1').inProgressTurn).toEqual([held]);

    const resolved: SessionEvent = {
      type: 'capability_approval_resolved',
      seq: 2,
      approvalId: 'appr-1',
      outcome: 'granted',
    };
    connections[0]!.push('capability_approval_resolved', resolved);
    expect(useSessionStreamStore.getState().getSession('sess-1').inProgressTurn).toEqual([
      held,
      resolved,
    ]);
  });

  it('dispatches a connection-state change into the store', () => {
    manager.attachSession('sess-1');
    connections[0]!.emitState('connected');
    expect(useSessionStreamStore.getState().getSession('sess-1').connectionState).toBe('connected');
  });

  it('dispatches a session-list event into the list store', () => {
    manager.connectList();
    const streaming = { ...STATUS, lifecycle: 'streaming' as const };
    connections[0]!.push('session_status', {
      type: 'session_status',
      sessionId: 'sess-1',
      status: streaming,
    });
    expect(useSessionListStore.getState().statuses['sess-1']).toEqual(streaming);
  });

  it('a session_removed event evicts the entry from BOTH stores', () => {
    // Real failure mode: a deleted session must drop its per-session stream
    // projection immediately, not linger until LRU eviction. The binding fans a
    // session_removed list event out to the per-session stream store's
    // removeSession in addition to the list store.
    useSessionStreamStore.getState().applySnapshot('sess-1', SNAPSHOT);
    useSessionListStore
      .getState()
      .applyListEvent({ type: 'session_status', sessionId: 'sess-1', status: STATUS });
    manager.connectList();

    connections[0]!.push('session_removed', { type: 'session_removed', sessionId: 'sess-1' });

    expect(useSessionStreamStore.getState().sessions['sess-1']).toBeUndefined();
    expect(useSessionListStore.getState().sessions['sess-1']).toBeUndefined();
    expect(useSessionListStore.getState().statuses['sess-1']).toBeUndefined();
  });

  it('is idempotent — a second init does not re-install listeners', () => {
    const calls = (streamManager.setListeners as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    initSessionStreamBinding();
    expect(
      (streamManager.setListeners as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(calls);
  });

  it('marks a BACKGROUND session unseen on its streaming→settled edge', () => {
    // Real failure mode: the list store prunes settled statuses, so without the
    // unseen flag every trace of finished background work vanishes on settle.
    manager.connectList();
    const streaming = { ...STATUS, lifecycle: 'streaming' as const };
    connections[0]!.push('session_status', {
      type: 'session_status',
      sessionId: 'sess-bg',
      cwd: '/projects/bg',
      status: streaming,
    });
    connections[0]!.push('session_status', {
      type: 'session_status',
      sessionId: 'sess-bg',
      cwd: '/projects/bg',
      status: STATUS, // lifecycle: idle → settle edge
    });
    expect(useSessionListStore.getState().unseen['sess-bg']).toBe('/projects/bg');
    // The settled status itself is pruned as before.
    expect(useSessionListStore.getState().statuses['sess-bg']).toBeUndefined();
  });

  it('does NOT mark the actively-attached session unseen when it settles', () => {
    // The operator is watching the attached session settle — nothing is unseen.
    vi.spyOn(streamManager, 'getAttachedSessionId').mockReturnValue('sess-fg');
    manager.connectList();
    const streaming = { ...STATUS, lifecycle: 'streaming' as const };
    connections[0]!.push('session_status', {
      type: 'session_status',
      sessionId: 'sess-fg',
      status: streaming,
    });
    connections[0]!.push('session_status', {
      type: 'session_status',
      sessionId: 'sess-fg',
      status: STATUS,
    });
    expect(useSessionListStore.getState().unseen['sess-fg']).toBeUndefined();
  });

  it('does NOT mark a session that settles without having streamed', () => {
    // A bare idle re-announce (no observed streaming→settled edge) is not activity.
    manager.connectList();
    connections[0]!.push('session_status', {
      type: 'session_status',
      sessionId: 'sess-quiet',
      status: STATUS,
    });
    expect(useSessionListStore.getState().unseen['sess-quiet']).toBeUndefined();
  });

  it('a retire announce migrates client continuity state to the canonical id (NF-2)', () => {
    // Real failure mode (acceptance run 20260611-145454): the canonical id
    // usually resolves AFTER the trigger 202, so the announce on the global
    // stream is the only rekey signal this client gets — without this fan-out
    // the message the person can see on screen is orphaned under the request
    // UUID. (The QUEUE is not in here: the server owns it and follows the rekey
    // itself.)
    useSessionStreamStore
      .getState()
      .setOptimisticUserMessage('request-uuid', { id: 'opt-1', content: 'first words' });
    useAppStore.getState().loadCanvasForSession('request-uuid');
    manager.connectList();

    connections[0]!.push('session_status', {
      type: 'session_status',
      sessionId: 'canonical-id',
      retiredSessionId: 'request-uuid',
      status: { ...STATUS, lifecycle: 'streaming' as const },
    });

    expect(
      useSessionStreamStore.getState().getSession('canonical-id').optimisticUserMessage?.content
    ).toBe('first words');
    expect(
      useSessionStreamStore.getState().getSession('request-uuid').optimisticUserMessage
    ).toBeNull();
    // And the retirement is recorded for the URL rekey + cache reconciler.
    expect(useSessionListStore.getState().rekeys['request-uuid']).toBe('canonical-id');
    // Bind canonical canvas before the asynchronous URL loader can settle.
    expect(useAppStore.getState().canvasSessionId).toBe('canonical-id');
    installed.onSnapshot?.('canonical-id', SNAPSHOT);
    expect(useAppStore.getState().canvasStreamAttached).toBe(true);
    useAppStore.getState().loadCanvasForSession('canonical-id');
    expect(useAppStore.getState().canvasStreamAttached).toBe(true);
  });

  it('a session-stream reconnect forces the next send to re-include uiState', () => {
    // Real failure mode: the server holds session.uiState in memory only. After
    // a restart with the tab open, the SSE stream auto-reconnects while the
    // client's last-sent cache still says "unchanged" — so uiState stays omitted
    // and get_ui_state answers with fabricated defaults until the UI changes.
    // The binding must drop the cache entry on every (re)entry into 'connected'.
    clearUiStateSendCache('sess-ui');
    prepareUiStateForSend('sess-ui', UI_SNAPSHOT).commit();
    // Sanity: unchanged snapshot is omitted while the connection is healthy.
    expect(prepareUiStateForSend('sess-ui', UI_SNAPSHOT).uiState).toBeUndefined();

    manager.attachSession('sess-ui');
    connections[0]!.emitState('connected');
    connections[0]!.emitState('reconnecting');
    connections[0]!.emitState('connected'); // server restarted, stream came back

    expect(prepareUiStateForSend('sess-ui', UI_SNAPSHOT).uiState).toEqual(UI_SNAPSHOT);
  });

  it('a session_removed event also evicts the uiState send cache', () => {
    clearUiStateSendCache('sess-dead');
    prepareUiStateForSend('sess-dead', UI_SNAPSHOT).commit();
    manager.connectList();

    connections[0]!.push('session_removed', { type: 'session_removed', sessionId: 'sess-dead' });

    // Entry gone — a hypothetical next send would re-include the snapshot.
    expect(prepareUiStateForSend('sess-dead', UI_SNAPSHOT).uiState).toEqual(UI_SNAPSHOT);
  });

  it('re-baselines statuses (but not unseen flags) when the global stream connects', () => {
    // Real failure mode: session_status is fan-out-only — a 'streaming' held
    // across a server restart would pin a stale border forever.
    const streaming = { ...STATUS, lifecycle: 'streaming' as const };
    useSessionListStore
      .getState()
      .applyListEvent({ type: 'session_status', sessionId: 'stale', status: streaming });
    useSessionListStore.getState().markUnseen('done-bg', '/projects/bg');
    expect(listStateListener).toBeDefined();

    listStateListener!('connected', 0);

    expect(useSessionListStore.getState().statuses['stale']).toBeUndefined();
    expect(useSessionListStore.getState().unseen['done-bg']).toBe('/projects/bg');
  });
});

describe('account_usage reaches every open session on the account (spec claude-account-fleet §6 U)', () => {
  const account = (accountId: string | null, path: string, usedPct: number) => ({
    runtime: 'claude-code' as const,
    accountId,
    path,
    label: null,
    color: '#000',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [
      {
        key: 'five_hour',
        label: '5-hour window',
        usedPct,
        resetsAt: null,
        status: null,
        expired: false,
        observedAt: '2026-09-27T10:00:00.000Z',
        source: 'sdk_event' as const,
      },
    ],
    state: 'ok' as const,
    limit: null,
    updatedAt: '2026-09-27T10:00:00.000Z',
  });

  it('applies the event to sessions naming that account and leaves the others alone', () => {
    vi.restoreAllMocks();
    resetSessionStreamBinding();
    const handlers = new Map<string, (data: unknown) => void>();
    vi.spyOn(streamManager, 'setListeners').mockImplementation(() => {});
    vi.spyOn(streamManager, 'subscribeListConnectionState').mockImplementation(() => () => {});
    vi.spyOn(streamManager, 'subscribeEvent').mockImplementation((name, handler) => {
      handlers.set(name, handler);
      return () => {};
    });
    initSessionStreamBinding();

    const store = useSessionStreamStore.getState();
    const open = (id: string, usage: ReturnType<typeof account>) =>
      store.applySnapshot(id, { ...SNAPSHOT, status: { ...STATUS, accountUsage: usage } });
    open('a', account('work', '/h/.claude3', 10));
    open('b', account('work', '/h/.claude3', 10));
    open('c', account('default', '/h/.claude', 10));
    open('d', account(null, '/h/.claude9', 10));

    handlers.get('account_usage')!(account('work', '/h/.claude3', 70));
    handlers.get('account_usage')!(account(null, '/h/.claude9', 30));
    // Not an AccountUsage: ignored rather than written into a status.
    handlers.get('account_usage')!({ runtime: 'claude-code' });

    const pct = (id: string) =>
      useSessionStreamStore.getState().getSession(id).status?.accountUsage?.windows[0]?.usedPct;
    expect(pct('a')).toBe(70);
    expect(pct('b')).toBe(70);
    expect(pct('c')).toBe(10);
    expect(pct('d')).toBe(30);
  });
});

describe('account_usage matching and the Claude subscription bar', () => {
  function usage(runtime: 'claude-code' | 'codex', usedPct: number) {
    return {
      runtime,
      accountId: 'default',
      path: runtime === 'codex' ? '/h/.codex' : '/h/.claude',
      label: null,
      color: '#000',
      subscriptionType: null,
      plan: null,
      credits: null,
      spend: null,
      windows: [
        {
          key: 'five_hour',
          label: '5-hour window',
          usedPct,
          resetsAt: null,
          status: null,
          expired: false,
          observedAt: '2026-09-27T10:00:00.000Z',
          source: 'sdk_event' as const,
        },
      ],
      state: 'ok' as const,
      limit: null,
      updatedAt: null,
    };
  }

  beforeEach(() => {
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  });

  it('a Codex default event never touches a Claude default session', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot('claude', {
      ...SNAPSHOT,
      status: { ...STATUS, accountUsage: usage('claude-code', 10) },
    });
    store.applyAccountUsage(usage('codex', 90));
    expect(
      useSessionStreamStore.getState().getSession('claude').status?.accountUsage?.runtime
    ).toBe('claude-code');
  });

  it("moves a Claude subscription session's bar with its account and keeps its cost; pay-as-you-go stays", () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot('sub', {
      ...SNAPSHOT,
      status: {
        ...STATUS,
        accountUsage: usage('claude-code', 10),
        usage: {
          kind: 'subscription',
          utilization: 0.1,
          costUsd: 0.3,
          detail: 'Using overage capacity',
        },
      },
    });
    store.applySnapshot('key', {
      ...SNAPSHOT,
      status: {
        ...STATUS,
        accountUsage: usage('claude-code', 10),
        usage: { kind: 'pay-as-you-go', costUsd: 2 },
      },
    });
    store.applyAccountUsage(usage('claude-code', 70));
    const get = (id: string) => useSessionStreamStore.getState().getSession(id).status?.usage;
    expect(get('sub')).toEqual({
      kind: 'subscription',
      utilization: 0.7,
      windowLabel: '5-hour window',
      costUsd: 0.3,
      detail: 'Using overage capacity',
    });
    expect(get('key')).toEqual({ kind: 'pay-as-you-go', costUsd: 2 });
  });
});

describe('when the session lists were last declared wrong (DOR-2891)', () => {
  beforeEach(() => resetSessionListResetMarker());

  interface Bound {
    handlers: Map<string, (data: unknown) => void>;
    setListState: (state: ConnectionState) => void;
  }

  function bind(): Bound {
    vi.restoreAllMocks();
    resetSessionStreamBinding();
    const handlers = new Map<string, (data: unknown) => void>();
    const stateListeners: Array<(state: ConnectionState, failedAttempts: number) => void> = [];
    vi.spyOn(streamManager, 'setListeners').mockImplementation(() => {});
    vi.spyOn(streamManager, 'subscribeListConnectionState').mockImplementation((listener) => {
      stateListeners.push(listener);
      return () => {};
    });
    vi.spyOn(streamManager, 'subscribeEvent').mockImplementation((name, handler) => {
      handlers.set(name, handler);
      return () => {};
    });
    initSessionStreamBinding();
    return { handlers, setListState: (state) => stateListeners.forEach((l) => l(state, 0)) };
  }

  it('marks lists a fresh window fetched before its first frame when that frame names a switch', () => {
    const { handlers } = bind();
    const before = Date.now() - 1;
    expect(predatesSessionListReset(before)).toBe(false);
    handlers.get('connected')!({ sessionListsResetAt: '2026-10-13T11:00:00.000Z' });
    expect(predatesSessionListReset(before)).toBe(true);
  });

  it('records a live account switch', () => {
    const { handlers } = bind();
    handlers.get('connected')!({ connectedAt: new Date().toISOString() });
    const before = Date.now() - 1;
    expect(predatesSessionListReset(before)).toBe(false);
    handlers.get('session_list_invalidated')!({ changedAt: '2026-10-13T11:00:00.000Z' });
    expect(predatesSessionListReset(before)).toBe(true);
  });

  it('distrusts every list from a drop until the reconnect names the last switch', () => {
    // The stream says `connected` (and the reconnect invalidates every list)
    // one round trip before its first frame can say a switch was missed.
    const { handlers, setListState } = bind();
    handlers.get('connected')!({ connectedAt: new Date().toISOString() });
    const cachedAt = Date.now() - 1;
    setListState('reconnecting');
    setListState('connecting');
    setListState('connected');
    expect(predatesSessionListReset(cachedAt)).toBe(true);
    handlers.get('connected')!({ connectedAt: new Date().toISOString() });
    expect(predatesSessionListReset(cachedAt)).toBe(false);
  });

  it('learns of a missed switch on its own clock, whatever the server’s says', () => {
    // A server clock an hour behind (or ahead) of this window must not decide
    // which lists are trusted: only that the switch is one not heard before.
    const { handlers } = bind();
    handlers.get('connected')!({ connectedAt: new Date().toISOString() });
    const cachedAt = Date.now() - 1;
    handlers.get('connected')!({ sessionListsResetAt: '1999-01-01T00:00:00.000Z' });
    expect(predatesSessionListReset(cachedAt)).toBe(true);
    // A list fetched after the frame is trusted.
    const fetchedLater = Date.now() + 1;
    expect(predatesSessionListReset(fetchedLater)).toBe(false);
  });

  it('does not count a switch twice when a reconnect names one it heard live', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-13T12:00:00.000Z') });
    try {
      const { handlers } = bind();
      handlers.get('connected')!({ connectedAt: new Date().toISOString() });
      handlers.get('session_list_invalidated')!({ changedAt: '2026-10-13T11:00:00.000Z' });
      vi.advanceTimersByTime(1_000);
      const fetchedAfterSwitch = Date.now();
      vi.advanceTimersByTime(1_000);
      handlers.get('connected')!({ sessionListsResetAt: '2026-10-13T11:00:00.000Z' });
      expect(predatesSessionListReset(fetchedAfterSwitch)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('distrusts every list while a hidden tab’s released stream opens again', () => {
    // A hidden tab's stream is closed without ever reporting itself down, then
    // reopens through `connecting`: a switch could have been missed meanwhile.
    const { handlers, setListState } = bind();
    handlers.get('connected')!({ connectedAt: new Date().toISOString() });
    const cachedAt = Date.now() - 1;
    setListState('connecting');
    expect(predatesSessionListReset(cachedAt)).toBe(true);
    handlers.get('connected')!({ connectedAt: new Date().toISOString() });
    expect(predatesSessionListReset(cachedAt)).toBe(false);
  });

  it('trusts a list fetched while the stream is down: it is the server as it is now', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-13T12:00:00.000Z') });
    try {
      const { handlers, setListState } = bind();
      handlers.get('connected')!({ connectedAt: new Date().toISOString() });
      const beforeDrop = Date.now();
      vi.advanceTimersByTime(1_000);
      setListState('reconnecting');
      vi.advanceTimersByTime(1_000);
      const whileDown = Date.now();
      expect(predatesSessionListReset(beforeDrop)).toBe(true);
      expect(predatesSessionListReset(whileDown)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
