// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { useSessionStreamStore } from '../session-stream-store';
import {
  SID,
  STATUS,
  MESSAGE,
  snapshot,
  queued,
  queueUpdate,
  approvalEvent,
} from './session-stream-store.fixtures';

describe('useSessionStreamStore', () => {
  beforeEach(() => {
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
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

  it('a turn_input SURVIVES the event-handling path and rides the open turn (AC5)', () => {
    // Real failure mode this pins: a SessionEvent member not routed by the store
    // is silently dropped — a steer that renders in dev and vanishes in prod.
    // The store must fold turn_input onto the open turn, without opening or
    // closing one, so it reaches the projection that renders it inline.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, { type: 'text_delta', seq: 2, text: 'working on it' });
    store.applyEvent(SID, {
      type: 'turn_input',
      seq: 3,
      content: 'also check the docs',
      disposition: 'steer',
      messageId: 'm-1',
    });
    const s = useSessionStreamStore.getState().getSession(SID);
    // Not dropped: it is on the open turn, in arrival order, and no turn boundary
    // was manufactured by it.
    expect(s.inProgressTurn.map((e) => e.type)).toEqual(['turn_start', 'text_delta', 'turn_input']);
    const steer = s.inProgressTurn.find((e) => e.type === 'turn_input');
    expect(steer).toMatchObject({ content: 'also check the docs', messageId: 'm-1' });
  });

  it('a turn another chat started does not count as the person asking (spin-off-chats §6)', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot());
    const before = useSessionStreamStore.getState().getSession(SID).userTurnCount;
    // Seqs above the snapshot's cursor (5), so the store applies them.
    store.applyEvent(SID, { type: 'turn_start', seq: 6 });
    store.applyEvent(SID, { type: 'turn_end', seq: 7 });
    const afterPerson = useSessionStreamStore.getState().getSession(SID).userTurnCount;
    expect(afterPerson).toBe(before + 1);
    store.applyEvent(SID, {
      type: 'turn_start',
      seq: 8,
      userMessage: 'fenced',
      chatMessages: [
        {
          id: 'cm-1',
          kind: 'report',
          from: { chatId: 'chat-b', agentName: 'Builder' },
          text: 'Done.',
          delivery: 'queue',
          status: 'working',
          sentAt: '2026-10-09T10:00:00.000Z',
        },
      ],
    });
    expect(useSessionStreamStore.getState().getSession(SID).userTurnCount).toBe(afterPerson);
  });

  it('chat_activity moves the version the Sent cards re-read on', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot());
    const before = useSessionStreamStore.getState().getSession(SID).chatActivityVersion;
    store.applyEvent(SID, { type: 'chat_activity', seq: 6 });
    expect(useSessionStreamStore.getState().getSession(SID).chatActivityVersion).toBe(before + 1);
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

  it('setHistoryMessages keeps an UNRESOLVED sign-in card when it clears the turn (DOR-1004)', () => {
    // Real failure mode: the sign-in card is asked for in one turn and answered
    // minutes later in a browser. Everything else the turn produced is in the
    // reloaded history by now — the card is not, and never will be, so clearing
    // it deletes the link the person walked away to use.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, { type: 'text_delta', seq: 2, text: 'Connecting your meeting notes.' });
    store.applyEvent(SID, {
      type: 'mcp_signin_required',
      seq: 3,
      serverName: 'granola',
      agentId: '01HV7KJZZZ0000000000000000',
      flowId: 'flow-1',
      authorizeUrl: 'https://mcp.test.local/authorize',
      disclosure: 'DorkOS stores the token on this machine.',
    });
    store.applyEvent(SID, { type: 'turn_end', seq: 4 });

    store.setHistoryMessages(SID, [MESSAGE]);

    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn.map((e) => e.type)).toEqual(['mcp_signin_required']);
  });

  it('turn_start carries a sign-in receipt exactly one turn further (DOR-1004)', () => {
    // Signing in triggers a resume turn almost immediately. Clearing the turn on
    // its turn_start erased the receipt about a second after it appeared — the
    // person walked back from their browser to a transcript that never mentioned
    // the sign-in. One turn of grace, then the conversation moves on.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, {
      type: 'mcp_signin_required',
      seq: 2,
      serverName: 'granola',
      agentId: '01HV7KJZZZ0000000000000000',
      flowId: 'flow-1',
      authorizeUrl: 'https://mcp.test.local/authorize',
      disclosure: 'DorkOS stores the token on this machine.',
    });
    store.applyEvent(SID, { type: 'turn_end', seq: 3 });
    store.setHistoryMessages(SID, [MESSAGE]);
    store.applyEvent(SID, {
      type: 'mcp_signin_resolved',
      seq: 4,
      flowId: 'flow-1',
      outcome: 'connected',
    });

    // The resume turn the sign-in caused: the receipt rides through it.
    store.applyEvent(SID, { type: 'turn_start', seq: 5 });
    expect(
      useSessionStreamStore
        .getState()
        .getSession(SID)
        .inProgressTurn.map((e) => e.type)
    ).toEqual(['mcp_signin_required', 'mcp_signin_resolved', 'turn_start']);

    // The turn after that retires it.
    store.applyEvent(SID, { type: 'turn_end', seq: 6 });
    store.applyEvent(SID, { type: 'turn_start', seq: 7 });
    expect(
      useSessionStreamStore
        .getState()
        .getSession(SID)
        .inProgressTurn.map((e) => e.type)
    ).toEqual(['turn_start']);
  });

  // Real failure mode, once per event type: a type missing from
  // TURN_EVENT_TYPES is dropped by the default arm, so its row only appears
  // after the history reload and the live turn renders lean (task #19,
  // DOR-118/DOR-125, DOR-1215, DOR-795, DOR-2636).
  it('retains every fidelity event in the live turn (DOR-1215, DOR-795, DOR-2636)', () => {
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, { type: 'thinking_delta', seq: 2, text: 'hmm' });
    store.applyEvent(SID, { type: 'tool_progress', seq: 3, toolCallId: 't1', content: 'out' });
    store.applyEvent(SID, { type: 'hook_update', seq: 4, hookId: 'h1', status: 'running' });
    store.applyEvent(SID, { type: 'memory_recall', seq: 5, mode: 'select', memories: [] });
    store.applyEvent(SID, { type: 'system_status', seq: 6, message: 'Running hook "pre"…' });
    store.applyEvent(SID, {
      type: 'compact_boundary',
      seq: 7,
      trigger: 'manual',
      preTokens: 51_226,
      postTokens: 4_151,
    });
    store.applyEvent(SID, {
      type: 'permission_denied',
      seq: 8,
      toolCallId: 'toolu_async_1',
      toolName: 'Bash',
      message: 'Backgrounded agents cannot request permission.',
      reasonType: 'asyncAgent',
      agentId: 'agent_child_7',
    });
    store.applyEvent(SID, {
      type: 'model_substituted',
      seq: 9,
      from: 'opus',
      fromName: 'Opus',
      to: 'md_suggested',
      toName: 'Suggested',
      reason: 'credits-not-covered',
    });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn.map((e) => e.type)).toEqual([
      'turn_start',
      'thinking_delta',
      'tool_progress',
      'hook_update',
      'memory_recall',
      'system_status',
      'compact_boundary',
      'permission_denied',
      'model_substituted',
    ]);
    expect(s.inProgressTurn[6]).toMatchObject({ trigger: 'manual', preTokens: 51_226 });
    expect(s.inProgressTurn[7]).toMatchObject({ agentId: 'agent_child_7' });
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
    it('moves the optimistic message and the trigger latch to the canonical id', () => {
      const store = useSessionStreamStore.getState();
      store.setOptimisticUserMessage('request-uuid', { id: 'opt-1', content: 'first send' });
      store.setTriggerPending('request-uuid', true);

      store.migrateSessionContinuity('request-uuid', 'canonical-id');

      const target = useSessionStreamStore.getState().getSession('canonical-id');
      expect(target.optimisticUserMessage).toEqual({ id: 'opt-1', content: 'first send' });
      expect(target.triggerPending).toBe(true);

      const source = useSessionStreamStore.getState().getSession('request-uuid');
      expect(source.optimisticUserMessage).toBeNull();
      expect(source.triggerPending).toBe(false);
    });

    it('leaves the source projection (messages, turn, seq) intact for a still-open view', () => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot('request-uuid', snapshot());
      store.setTriggerPending('request-uuid', true);
      store.migrateSessionContinuity('request-uuid', 'canonical-id');
      const source = useSessionStreamStore.getState().getSession('request-uuid');
      expect(source.messages).toEqual([MESSAGE]);
      expect(source.lastAppliedSeq).toBe(5);
    });

    it('leaves the queue where it is — the server owns it and follows the rekey itself', () => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('request-uuid', queueUpdate(1, [queued('q1', 'queued while streaming')]));
      store.setTriggerPending('request-uuid', true);

      store.migrateSessionContinuity('request-uuid', 'canonical-id');

      expect(
        useSessionStreamStore.getState().getSession('canonical-id').queuedMessages
      ).toHaveLength(0);
      expect(
        useSessionStreamStore.getState().getSession('request-uuid').queuedMessages
      ).toHaveLength(1);
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
  });

  describe('setPinnedSession / pinned LRU eviction (DOR-298 PIP)', () => {
    /** Mirrors `MAX_RETAINED_SESSIONS` in session-stream-store.ts (not exported). */
    const RETENTION_LIMIT = 20;

    /** Seed `count` idle (no `inProgressTurn`) sessions, oldest id first. */
    function seedIdleSessions(
      store: ReturnType<typeof useSessionStreamStore.getState>,
      count: number
    ) {
      for (let i = 0; i < count; i++) {
        store.ensureSession(`s-${i}`);
      }
    }

    it('a pinned session survives eviction even when idle and past the retention limit', () => {
      // Real failure mode this guards: a popped-out widget board sits idle (no
      // inProgressTurn) while the operator works in other sessions — without the
      // pin, ordinary LRU eviction would drop its projection out from under the
      // still-live StreamManager connection (task 1.1), and the PIP panel would
      // go blank even though the stream itself is fine.
      const store = useSessionStreamStore.getState();
      seedIdleSessions(store, RETENTION_LIMIT); // s-0 (oldest) .. s-19 (newest)
      store.setPinnedSession('s-0'); // the oldest — first in line for eviction

      store.ensureSession('s-20'); // pushes past the limit, triggers touchAndGet's eviction loop

      const after = useSessionStreamStore.getState();
      expect(after.sessions['s-0']).toBeDefined();
      expect(after.sessionAccessOrder).toContain('s-0');
    });

    it('a session holding queued messages is evictable — the queue is not lost with it', () => {
      // The queue used to pin a session here (DOR-480), because evicting the
      // entry DELETED words nobody else was holding. The server holds them now,
      // so the entry is a pure projection again and the next snapshot brings the
      // queue straight back.
      const store = useSessionStreamStore.getState();
      store.applyEvent('s-0', queueUpdate(1, [queued('q1', 'do the migration next')]));
      seedIdleSessions(store, RETENTION_LIMIT); // s-0 .. s-19, s-0 first in line

      store.ensureSession('s-20'); // pushes past the limit

      expect(useSessionStreamStore.getState().sessions['s-0']).toBeUndefined();
    });
  });

  describe('queue_update (the server’s queue, projected)', () => {
    it('hydrates the queue from the snapshot, so a refresh shows what is waiting', () => {
      useSessionStreamStore
        .getState()
        .applySnapshot(SID, snapshot({ queuedMessages: [queued('q1', 'and then the docs')] }));
      expect(
        useSessionStreamStore
          .getState()
          .getSession(SID)
          .queuedMessages.map((m) => m.content)
      ).toEqual(['and then the docs']);
    });

    it('replaces the whole queue on every update, never merges', () => {
      const store = useSessionStreamStore.getState();
      store.applyEvent(SID, queueUpdate(1, [queued('q1', 'first'), queued('q2', 'second')]));
      // A reorder in another window: same ids, different order, nothing added.
      store.applyEvent(SID, queueUpdate(2, [queued('q2', 'second'), queued('q1', 'first')]));
      expect(
        useSessionStreamStore
          .getState()
          .getSession(SID)
          .queuedMessages.map((m) => m.id)
      ).toEqual(['q2', 'q1']);
    });

    it('keeps the receipt of a message that is still waiting', () => {
      useSessionStreamStore.getState().applyEvent(
        SID,
        queueUpdate(1, [queued('q1', 'change course')], {
          messageId: 'q1',
          requested: 'steer',
          applied: 'queue',
          degradedBecause: 'unsupported',
        })
      );
      expect(
        useSessionStreamStore.getState().getSession(SID).queueOutcomes['q1']?.degradedBecause
      ).toBe('unsupported');
    });
  });

  it('removeSession drops the session and its access-order entry', () => {
    useSessionStreamStore.getState().applySnapshot(SID, snapshot());
    useSessionStreamStore.getState().removeSession(SID);
    expect(useSessionStreamStore.getState().sessions[SID]).toBeUndefined();
    expect(useSessionStreamStore.getState().sessionAccessOrder).not.toContain(SID);
  });
});
