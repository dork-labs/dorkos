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

  it('records the fidelity events (thinking/progress/hook/memory) in the turn (task #19)', () => {
    // Real failure mode: a fidelity event type missing from TURN_EVENT_TYPES is
    // silently dropped by the store — the live turn renders lean while the
    // post-turn history reload shows the full detail (jarring pop-in).
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, { type: 'thinking_delta', seq: 2, text: 'hmm' });
    store.applyEvent(SID, { type: 'tool_progress', seq: 3, toolCallId: 't1', content: 'out' });
    store.applyEvent(SID, { type: 'hook_update', seq: 4, hookId: 'h1', status: 'running' });
    store.applyEvent(SID, { type: 'memory_recall', seq: 5, mode: 'select', memories: [] });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn.map((e) => e.type)).toEqual([
      'turn_start',
      'thinking_delta',
      'tool_progress',
      'hook_update',
      'memory_recall',
    ]);
    expect(s.lastAppliedSeq).toBe(5);
  });

  it('retains system_status events in the turn so the strip producer sees them (DOR-118/DOR-125)', () => {
    // Real failure mode: system_status was omitted from TURN_EVENT_TYPES, so the
    // status strip's producer (useSystemStatusEvents) was starved live —
    // "Compacting context…" and "Running hook…" only appeared after the durable
    // history reload. They must be retained in the live turn.
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, { type: 'system_status', seq: 2, message: 'Running hook "pre"...' });
    store.applyEvent(SID, {
      type: 'system_status',
      seq: 3,
      message: 'Compacting context…',
      status: 'compacting',
    });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn.map((e) => e.type)).toEqual([
      'turn_start',
      'system_status',
      'system_status',
    ]);
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

  it('interaction_resolved removes the pending DTO and records the event in the turn (CLI-C1)', () => {
    // Real failure mode: without a resolution signal the store only ever
    // cleared pendingInteractions via a snapshot replace — after the turn-end
    // reconcile cleared the turn, a stale DTO re-folded as a ghost
    // Approve/Deny card until the next cold connect.
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, approvalEvent(2, 'tool-1'));
    expect(useSessionStreamStore.getState().getSession(SID).pendingInteractions).toHaveLength(1);

    store.applyEvent(SID, { type: 'interaction_resolved', id: 'tool-1', seq: 3 });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.pendingInteractions).toHaveLength(0);
    expect(s.inProgressTurn.some((e) => e.type === 'interaction_resolved')).toBe(true);
    expect(s.lastAppliedSeq).toBe(3);
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

  it('turn_start clears the trigger-pending latch (CLI-B7)', () => {
    // Real failure mode: the latch must release the moment the triggered turn
    // materializes, or the composer would stay in queue mode through the turn.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot());
    store.setTriggerPending(SID, true);
    expect(useSessionStreamStore.getState().getSession(SID).triggerPending).toBe(true);
    store.applyEvent(SID, { type: 'turn_start', seq: 6 });
    expect(useSessionStreamStore.getState().getSession(SID).triggerPending).toBe(false);
  });

  it('turn_end clears a stale trigger-pending latch', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot());
    store.setTriggerPending(SID, true);
    store.applyEvent(SID, { type: 'turn_end', seq: 6 });
    expect(useSessionStreamStore.getState().getSession(SID).triggerPending).toBe(false);
  });

  it('applySnapshot increments hydrationGeneration (CLI-B9 snapshot/live distinction)', () => {
    // Real failure mode: a switch-back snapshot reporting idle where the stale
    // projection said streaming must be distinguishable from a live settle edge
    // (otherwise the turn-end reconcile fires a spurious reload + sound).
    const store = useSessionStreamStore.getState();
    expect(store.getSession(SID).hydrationGeneration).toBe(0);
    store.applySnapshot(SID, snapshot());
    expect(useSessionStreamStore.getState().getSession(SID).hydrationGeneration).toBe(1);
    store.applySnapshot(SID, snapshot({ cursor: 9 }));
    expect(useSessionStreamStore.getState().getSession(SID).hydrationGeneration).toBe(2);
  });

  describe('migrateSessionContinuity (rekey follow-through, NF-2)', () => {
    it('moves the queue, optimistic message, and trigger latch to the canonical id', () => {
      // Real failure mode (acceptance run 20260611-145454, NF-2): a message
      // queued under the request UUID was orphaned when the view moved to the
      // canonical id and never delivered.
      const store = useSessionStreamStore.getState();
      store.enqueueMessage('request-uuid', 'queued while streaming');
      store.setOptimisticUserMessage('request-uuid', { id: 'opt-1', content: 'first send' });
      store.setTriggerPending('request-uuid', true);

      store.migrateSessionContinuity('request-uuid', 'canonical-id');

      const target = useSessionStreamStore.getState().getSession('canonical-id');
      expect(target.queuedMessages.map((m) => m.content)).toEqual(['queued while streaming']);
      expect(target.optimisticUserMessage).toEqual({ id: 'opt-1', content: 'first send' });
      expect(target.triggerPending).toBe(true);

      const source = useSessionStreamStore.getState().getSession('request-uuid');
      expect(source.queuedMessages).toEqual([]);
      expect(source.optimisticUserMessage).toBeNull();
      expect(source.triggerPending).toBe(false);
    });

    it('appends behind messages already queued under the canonical id', () => {
      const store = useSessionStreamStore.getState();
      store.enqueueMessage('canonical-id', 'already here');
      store.enqueueMessage('request-uuid', 'migrated');
      store.migrateSessionContinuity('request-uuid', 'canonical-id');
      expect(
        useSessionStreamStore
          .getState()
          .getSession('canonical-id')
          .queuedMessages.map((m) => m.content)
      ).toEqual(['already here', 'migrated']);
    });

    it('a target-side optimistic message wins over the migrated one', () => {
      // The 202 path may have already re-keyed a NEWER send; the stale source
      // copy must not clobber it (it is dropped, not preserved).
      const store = useSessionStreamStore.getState();
      store.setOptimisticUserMessage('canonical-id', { id: 'newer', content: 'newer send' });
      store.setOptimisticUserMessage('request-uuid', { id: 'older', content: 'older send' });
      store.migrateSessionContinuity('request-uuid', 'canonical-id');
      expect(
        useSessionStreamStore.getState().getSession('canonical-id').optimisticUserMessage
      ).toEqual({ id: 'newer', content: 'newer send' });
      expect(
        useSessionStreamStore.getState().getSession('request-uuid').optimisticUserMessage
      ).toBeNull();
    });

    it('is idempotent — the second observation point finds an empty source and no-ops', () => {
      // Both the 202 path and the retire announce may fire for one rekey.
      const store = useSessionStreamStore.getState();
      store.enqueueMessage('request-uuid', 'once');
      store.migrateSessionContinuity('request-uuid', 'canonical-id');
      store.migrateSessionContinuity('request-uuid', 'canonical-id');
      expect(
        useSessionStreamStore.getState().getSession('canonical-id').queuedMessages
      ).toHaveLength(1);
    });

    it('no-ops on an identity migration and never creates an entry for an empty source', () => {
      const store = useSessionStreamStore.getState();
      store.enqueueMessage(SID, 'kept');
      store.migrateSessionContinuity(SID, SID);
      expect(useSessionStreamStore.getState().getSession(SID).queuedMessages).toHaveLength(1);
      store.migrateSessionContinuity('never-seen', 'canonical-id');
      expect(useSessionStreamStore.getState().sessions['canonical-id']).toBeUndefined();
    });

    it('leaves the source projection (messages, turn, seq) intact for a still-open view', () => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot('request-uuid', snapshot());
      store.enqueueMessage('request-uuid', 'queued');
      store.migrateSessionContinuity('request-uuid', 'canonical-id');
      const source = useSessionStreamStore.getState().getSession('request-uuid');
      expect(source.messages).toEqual([MESSAGE]);
      expect(source.lastAppliedSeq).toBe(5);
    });
  });
});

describe('useSessionListStore', () => {
  beforeEach(() => {
    useSessionListStore.setState({
      sessions: {},
      statuses: {},
      statusCwds: {},
      unseen: {},
      rekeys: {},
    });
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

  it('applyListEvent sets a session status while the lifecycle carries a signal', () => {
    const streaming = { ...STATUS, lifecycle: 'streaming' as const };
    useSessionListStore.getState().applyListEvent({
      type: 'session_status',
      sessionId: SID,
      cwd: '/work/a',
      status: streaming,
    });
    expect(useSessionListStore.getState().statuses[SID]).toEqual(streaming);
    expect(useSessionListStore.getState().statusCwds[SID]).toBe('/work/a');
  });

  it('applyListEvent prunes the entry when the lifecycle settles (idle/interrupted)', () => {
    // Discovery only removes DEFAULT_CWD sessions, so settled statuses must
    // prune here or a long-lived client accumulates an entry per session that
    // ever transitioned (scanned per agent row).
    const store = useSessionListStore.getState();
    store.applyListEvent({
      type: 'session_status',
      sessionId: SID,
      cwd: '/work/a',
      status: { ...STATUS, lifecycle: 'streaming' },
    });
    store.applyListEvent({ type: 'session_status', sessionId: SID, status: STATUS }); // idle
    expect(useSessionListStore.getState().statuses[SID]).toBeUndefined();
    expect(useSessionListStore.getState().statusCwds[SID]).toBeUndefined();
  });

  it('applyListEvent retires the pre-rekey request UUID named by retiredSessionId', () => {
    // First-turn F2 race: transitions broadcast under the request UUID before
    // the canonical id resolves; no session_removed ever fires for it. The
    // rekey re-announce must drop it or its 'streaming' pins agent-row
    // liveness forever.
    const store = useSessionListStore.getState();
    store.applyListEvent({
      type: 'session_status',
      sessionId: 'request-uuid',
      cwd: '/work/a',
      status: { ...STATUS, lifecycle: 'streaming' },
    });
    store.markUnseen('request-uuid', '/work/a');
    store.applyListEvent({
      type: 'session_status',
      sessionId: SID,
      cwd: '/work/a',
      retiredSessionId: 'request-uuid',
      status: { ...STATUS, lifecycle: 'streaming' },
    });
    expect(useSessionListStore.getState().statuses['request-uuid']).toBeUndefined();
    expect(useSessionListStore.getState().statusCwds['request-uuid']).toBeUndefined();
    // A retired UUID can never become active, so a lingering unseen flag would
    // never clear — the retire must drop it too.
    expect(useSessionListStore.getState().unseen['request-uuid']).toBeUndefined();
    expect(useSessionListStore.getState().statuses[SID]).toBeDefined();
    // The retirement is recorded so late-bound consumers (the URL rekey, the
    // query-cache reconciler) can follow it after the fact (NF-2/NF-3).
    expect(useSessionListStore.getState().rekeys['request-uuid']).toBe(SID);
  });

  it('the retire announce also drops a metadata row held under the retired id (NF-3)', () => {
    const store = useSessionListStore.getState();
    store.applyListEvent({
      type: 'session_upserted',
      session: { ...SESSION, id: 'request-uuid', title: 'Session request-' },
    });
    store.applyListEvent({
      type: 'session_status',
      sessionId: SID,
      retiredSessionId: 'request-uuid',
      status: { ...STATUS, lifecycle: 'streaming' },
    });
    expect(useSessionListStore.getState().sessions['request-uuid']).toBeUndefined();
  });

  it('applyListEvent removes a session and its status', () => {
    const store = useSessionListStore.getState();
    store.applyListEvent({ type: 'session_upserted', session: SESSION });
    store.applyListEvent({ type: 'session_status', sessionId: SID, status: STATUS });
    store.applyListEvent({ type: 'session_removed', sessionId: SID });
    expect(useSessionListStore.getState().sessions[SID]).toBeUndefined();
    expect(useSessionListStore.getState().statuses[SID]).toBeUndefined();
  });

  it('markUnseen / clearUnseen roundtrip, carrying the session cwd', () => {
    const store = useSessionListStore.getState();
    store.markUnseen(SID, '/projects/a');
    expect(useSessionListStore.getState().unseen[SID]).toBe('/projects/a');
    store.clearUnseen(SID);
    expect(useSessionListStore.getState().unseen[SID]).toBeUndefined();
  });

  it('session_removed also drops the unseen flag', () => {
    const store = useSessionListStore.getState();
    store.markUnseen(SID);
    store.applyListEvent({ type: 'session_removed', sessionId: SID });
    expect(useSessionListStore.getState().unseen[SID]).toBeUndefined();
  });

  it('resetStatuses clears status projections but keeps metadata and unseen flags', () => {
    // Real failure mode: the reconnect re-baseline must not wipe the sidebar
    // (sessions) or acknowledged-pending work signals (unseen) — only the
    // fan-out-derived live statuses that may be stale after the gap.
    const store = useSessionListStore.getState();
    const streaming = { ...STATUS, lifecycle: 'streaming' as const };
    store.applyListEvent({ type: 'session_upserted', session: SESSION });
    store.applyListEvent({ type: 'session_status', sessionId: SID, cwd: '/p', status: streaming });
    store.markUnseen('other-session', '/p');
    store.resetStatuses();
    const state = useSessionListStore.getState();
    expect(state.statuses).toEqual({});
    expect(state.statusCwds).toEqual({});
    expect(state.sessions[SID]).toEqual(SESSION);
    expect(state.unseen['other-session']).toBe('/p');
  });
});
