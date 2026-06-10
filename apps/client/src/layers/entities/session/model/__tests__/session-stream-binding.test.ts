import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  beforeEach(() => {
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {} });
    resetSessionStreamBinding();

    // Capture the real listener object the binding installs on the singleton.
    installed = {};
    vi.spyOn(streamManager, 'setListeners').mockImplementation((l) => {
      installed = l;
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
    connections[0]!.push('session_status', {
      type: 'session_status',
      sessionId: 'sess-1',
      status: STATUS,
    });
    expect(useSessionListStore.getState().statuses['sess-1']).toEqual(STATUS);
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
});
