import { describe, it, expect, beforeEach } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';

import { useSessionStreamStore, DEFAULT_SESSION_STREAM_STATE } from '../session-stream-store';
import { useSessionListStore } from '../session-list-store';

const SID = 'sess-1';

const STATUS: SessionStatus = {
  contextUsage: {
    totalTokens: 100,
    maxTokens: 200,
    outputTokens: 10,
    cacheReadTokens: 5,
    cacheCreationTokens: 2,
  },
  cost: 0.01,
  cacheStats: { cacheReadTokens: 5, cacheCreationTokens: 2 },
  model: 'claude',
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
};

const MESSAGE: HistoryMessage = { id: 'm1', role: 'user', content: 'hello' };

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    messages: [MESSAGE],
    inProgressTurn: null,
    status: STATUS,
    pendingInteractions: [],
    cursor: 5,
    ...overrides,
  };
}

function approvalEvent(seq: number, id: string): SessionEvent {
  return {
    type: 'approval_required',
    seq,
    startedAt: 1000,
    remainingMs: 30000,
    id,
    toolName: 'Bash',
    input: 'ls',
    hasSuggestions: false,
  };
}

describe('useSessionStreamStore', () => {
  beforeEach(() => {
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  });

  it('getSession returns the default state for an unknown id', () => {
    expect(useSessionStreamStore.getState().getSession('unknown')).toEqual(
      DEFAULT_SESSION_STREAM_STATE
    );
  });

  it('applySnapshot hydrates messages/status and sets both seq cursors', () => {
    useSessionStreamStore.getState().applySnapshot(SID, snapshot());
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.messages).toEqual([MESSAGE]);
    expect(s.status).toEqual(STATUS);
    expect(s.lastAppliedSeq).toBe(5);
    expect(s.streamReadyCursor).toBe(5);
    expect(s.inProgressTurn).toEqual([]);
  });

  it('applySnapshot clears an optimistic user message the snapshot already contains (mid-turn reconnect dedup)', () => {
    // Real failure mode: a reconnect during a turn delivers a snapshot whose
    // history already ends with the just-sent user message (written to JSONL at
    // turn start) — keeping the optimistic copy would render it twice until settle.
    const store = useSessionStreamStore.getState();
    store.setOptimisticUserMessage(SID, { id: 'opt-1', content: 'hello' });
    store.applySnapshot(SID, snapshot()); // snapshot history ends with user 'hello'
    expect(useSessionStreamStore.getState().getSession(SID).optimisticUserMessage).toBeNull();
  });

  it('applySnapshot keeps an optimistic user message the snapshot does not yet contain', () => {
    const store = useSessionStreamStore.getState();
    store.setOptimisticUserMessage(SID, { id: 'opt-2', content: 'newer message' });
    store.applySnapshot(SID, snapshot());
    expect(useSessionStreamStore.getState().getSession(SID).optimisticUserMessage).toEqual({
      id: 'opt-2',
      content: 'newer message',
    });
  });

  it('setHistoryMessages clears inProgressTurn by default but preserves it on request', () => {
    // Real failure mode: the turn_end reconcile reload resolves AFTER the next
    // turn already started (queued-flush race) — clearing then would wipe the
    // NEW turn's streamed events, not the settled turn's.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, { type: 'text_delta', seq: 2, text: 'next turn' });
    store.setHistoryMessages(SID, [MESSAGE], { preserveInProgressTurn: true });
    let s = useSessionStreamStore.getState().getSession(SID);
    expect(s.messages).toEqual([MESSAGE]);
    expect(s.inProgressTurn.map((e) => e.type)).toEqual(['turn_start', 'text_delta']);
    store.setHistoryMessages(SID, [MESSAGE]);
    s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn).toEqual([]);
  });

  it('applyEvent advances lastAppliedSeq and folds the event', () => {
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, { type: 'text_delta', seq: 2, text: 'hi' });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.lastAppliedSeq).toBe(2);
    expect(s.inProgressTurn.map((e) => e.type)).toEqual(['turn_start', 'text_delta']);
    expect(s.status?.lifecycle).toBe('streaming');
  });

  it('applyEvent is a NO-OP for a duplicate / out-of-order seq (idempotency guarantee)', () => {
    // Real failure mode: a resume that replays an already-seen event must not
    // double-apply text or rewind the projection — the core no-dupes guarantee.
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 5 }));
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, { type: 'text_delta', seq: 5, text: 'dup' }); // seq == cursor
    store.applyEvent(SID, { type: 'text_delta', seq: 3, text: 'old' }); // seq < cursor
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.lastAppliedSeq).toBe(5);
    expect(s.inProgressTurn).toEqual([]);
  });

  it('a duplicate-seq event does not churn LRU or evict a sibling (reconnect-replay churn)', () => {
    // Real failure mode: a reconnect that replays an already-seen gap re-delivers a
    // duplicate-seq event. If the idempotency guard runs AFTER touchAndGet, that
    // no-op event still rebuilds sessionAccessOrder (new identity → spurious
    // re-render) and can evict an idle sibling. The guard must run FIRST, leaving
    // both the projection AND the LRU bookkeeping byte-for-byte unchanged.
    const store = useSessionStreamStore.getState();
    store.applySnapshot('A', snapshot({ cursor: 5 }));
    store.ensureSession('B'); // idle sibling, present in access order
    const orderBefore = useSessionStreamStore.getState().sessionAccessOrder;
    const projectionABefore = useSessionStreamStore.getState().getSession('A');

    // Re-apply a duplicate-seq event to A (seq == cursor → already applied).
    store.applyEvent('A', { type: 'text_delta', seq: 5, text: 'dup' });

    const after = useSessionStreamStore.getState();
    // (a) A's projection is unchanged (same object identity — no immer mutation).
    expect(after.getSession('A')).toBe(projectionABefore);
    expect(after.getSession('A').inProgressTurn).toEqual([]);
    // (b) Access order is byte-for-byte unchanged and B was not evicted/reordered.
    expect(after.sessionAccessOrder).toBe(orderBefore);
    expect(after.sessions['B']).toBeDefined();
  });

  it('status_change partial merge does not zero contextUsage siblings', () => {
    // Real failure mode: a streaming delta carrying only outputTokens must not
    // wipe the totals (mirror the server projector's field-wise merge).
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    useSessionStreamStore.getState().applyEvent(SID, {
      type: 'status_change',
      seq: 1,
      status: { contextUsage: { outputTokens: 42 } },
    });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.status?.contextUsage).toEqual({
      totalTokens: 100,
      maxTokens: 200,
      outputTokens: 42, // updated
      cacheReadTokens: 5, // preserved
      cacheCreationTokens: 2, // preserved
    });
  });

  it('upserts pending interactions by id (no duplicates on re-emit)', () => {
    // Real failure mode: a re-emitted approval must update the existing card in
    // place, never stack a second one.
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, approvalEvent(1, 'int-1'));
    store.applyEvent(SID, approvalEvent(2, 'int-1')); // same id, newer seq
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.pendingInteractions).toHaveLength(1);
    expect(s.pendingInteractions[0]!.type).toBe('approval');
    expect(s.pendingInteractions[0]!.id).toBe('int-1');
  });

  it('setConnectionState updates the session connection state', () => {
    useSessionStreamStore.getState().setConnectionState(SID, 'connected');
    expect(useSessionStreamStore.getState().getSession(SID).connectionState).toBe('connected');
  });

  it('removeSession drops the session and its access-order entry', () => {
    useSessionStreamStore.getState().applySnapshot(SID, snapshot());
    useSessionStreamStore.getState().removeSession(SID);
    expect(useSessionStreamStore.getState().sessions[SID]).toBeUndefined();
    expect(useSessionStreamStore.getState().sessionAccessOrder).not.toContain(SID);
  });
});

describe('useSessionListStore', () => {
  beforeEach(() => {
    useSessionListStore.setState({ sessions: {}, statuses: {} });
  });

  const SESSION = {
    id: SID,
    title: 'Test',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    permissionMode: 'default' as const,
  };

  it('applyListEvent upserts a session', () => {
    useSessionListStore.getState().applyListEvent({ type: 'session_upserted', session: SESSION });
    expect(useSessionListStore.getState().sessions[SID]).toEqual(SESSION);
  });

  it('applyListEvent sets a session status', () => {
    useSessionListStore
      .getState()
      .applyListEvent({ type: 'session_status', sessionId: SID, status: STATUS });
    expect(useSessionListStore.getState().statuses[SID]).toEqual(STATUS);
  });

  it('applyListEvent removes a session and its status', () => {
    const store = useSessionListStore.getState();
    store.applyListEvent({ type: 'session_upserted', session: SESSION });
    store.applyListEvent({ type: 'session_status', sessionId: SID, status: STATUS });
    store.applyListEvent({ type: 'session_removed', sessionId: SID });
    expect(useSessionListStore.getState().sessions[SID]).toBeUndefined();
    expect(useSessionListStore.getState().statuses[SID]).toBeUndefined();
  });
});
