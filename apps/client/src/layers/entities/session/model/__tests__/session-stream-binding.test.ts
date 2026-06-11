import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConnectionState } from '@dorkos/shared/types';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';
import {
  StreamManager,
  streamManager,
  type SSEConnectionLike,
  type StreamManagerListeners,
} from '@/layers/shared/lib/transport';
import type { SSEConnectionOptions } from '@/layers/shared/lib/transport';

import { initSessionStreamBinding, resetSessionStreamBinding } from '../session-stream-binding';
import { useSessionStreamStore } from '../session-stream-store';
import { useSessionListStore } from '../session-list-store';

// End-to-end wiring test: prove that driving a StreamManager's (fake) connection
// results in the stores being updated through the binding's real listener object.
// We capture the listeners the binding installs on the singleton, then replay
// them through a fake-backed StreamManager so a pushed frame travels the full
// path (connection → StreamManager → binding listener → store) with no real
// network — the injected-fake-connection seam (see stream-manager.test.ts note).

class FakeConnection implements SSEConnectionLike {
  connect = vi.fn();
  disconnect = vi.fn();
  destroy = vi.fn();
  constructor(
    readonly url: string,
    readonly opts: SSEConnectionOptions
  ) {}
  push(eventName: string, data: unknown): void {
    this.opts.eventHandlers[eventName]?.(data);
  }
  emitState(state: Parameters<NonNullable<SSEConnectionOptions['onStateChange']>>[0]): void {
    this.opts.onStateChange?.(state, 0);
  }
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
  messages: [{ id: 'm1', role: 'user', content: 'hi' }],
  inProgressTurn: null,
  status: STATUS,
  pendingInteractions: [],
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
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
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
