import { describe, it, expect, beforeEach } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';
import type { MessageDeliveryOutcome, QueuedMessage } from '@dorkos/shared/schemas';

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
  usage: null,
  cacheStats: { cacheReadTokens: 5, cacheCreationTokens: 2 },
  model: 'claude',
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
  lastError: null,
};

const MESSAGE: HistoryMessage = { id: 'm1', role: 'user', content: 'hello' };

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    messages: [MESSAGE],
    inProgressTurn: null,
    status: STATUS,
    pendingInteractions: [],
    queuedMessages: [],
    cursor: 5,
    ...overrides,
  };
}

function queued(id: string, content: string): QueuedMessage {
  return { id, content, disposition: 'queue', enqueuedAt: 1000, enqueuedBy: 'window-a' };
}

function queueUpdate(
  seq: number,
  queue: QueuedMessage[],
  outcome?: MessageDeliveryOutcome
): SessionEvent {
  return { type: 'queue_update', seq, queue, ...(outcome ? { outcome } : {}) };
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
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
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

  /** The `mcp_signin_required` event for the card these tests drive. */
  function SIGNIN_REQUIRED(seq: number): SessionEvent {
    return {
      type: 'mcp_signin_required',
      seq,
      serverName: 'granola',
      agentId: '01HV7KJZZZ0000000000000000',
      flowId: 'flow-1',
      authorizeUrl: 'https://mcp.test.local/authorize',
      disclosure: 'DorkOS stores the token on this machine.',
    } as SessionEvent;
  }

  /** Run a turn that asks for a sign-in and ends, as the real flow does. */
  function signinTurn(store: ReturnType<typeof useSessionStreamStore.getState>, seq: number): void {
    store.applyEvent(SID, { type: 'turn_start', seq });
    store.applyEvent(SID, { type: 'text_delta', seq: seq + 1, text: 'Connecting your notes.' });
    store.applyEvent(SID, SIGNIN_REQUIRED(seq + 2));
    store.applyEvent(SID, { type: 'turn_end', seq: seq + 3 });
  }

  /** The sign-in event types currently on screen. */
  function signinTypes(): string[] {
    return useSessionStreamStore
      .getState()
      .getSession(SID)
      .inProgressTurn.filter((e) => e.type.startsWith('mcp_signin'))
      .map((e) => e.type);
  }

  it('setHistoryMessages keeps a RESOLVED card so the receipt survives (DOR-1004)', () => {
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
    store.applyEvent(SID, {
      type: 'mcp_signin_resolved',
      seq: 3,
      flowId: 'flow-1',
      outcome: 'connected',
    });
    store.applyEvent(SID, { type: 'turn_end', seq: 4 });

    store.setHistoryMessages(SID, [MESSAGE]);

    // Both halves: the card carries the server name, the resolution carries the
    // outcome, and the fold needs the pair to render the receipt at all.
    expect(
      useSessionStreamStore
        .getState()
        .getSession(SID)
        .inProgressTurn.map((e) => e.type)
    ).toEqual(['mcp_signin_required', 'mcp_signin_resolved']);
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

  it('retires the receipt after ONE turn even with a history reload between (DOR-1004)', () => {
    // The bug this pins: the grace mark used to be inferred from a `turn_start`
    // sitting in the outgoing list — and the reload path strips exactly that
    // event. So every settled turn handed the receipt a fresh turn of grace and
    // it never retired, while the server retired it after one. Four turns and
    // three reloads later it was still on screen.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    signinTurn(store, 1);
    store.setHistoryMessages(SID, [MESSAGE]);
    store.applyEvent(SID, {
      type: 'mcp_signin_resolved',
      seq: 5,
      flowId: 'flow-1',
      outcome: 'connected',
    });

    // The resume turn: the receipt rides through it, reload and all.
    store.applyEvent(SID, { type: 'turn_start', seq: 6 });
    store.applyEvent(SID, { type: 'turn_end', seq: 7 });
    store.setHistoryMessages(SID, [MESSAGE]);
    expect(signinTypes()).toEqual(['mcp_signin_required', 'mcp_signin_resolved']);

    // The turn after that retires it, and the reload cannot resurrect it.
    store.applyEvent(SID, { type: 'turn_start', seq: 8 });
    expect(signinTypes()).toEqual([]);
    store.applyEvent(SID, { type: 'turn_end', seq: 9 });
    store.setHistoryMessages(SID, [MESSAGE]);
    expect(signinTypes()).toEqual([]);

    // …and it stays gone however many more turns run.
    store.applyEvent(SID, { type: 'turn_start', seq: 10 });
    store.setHistoryMessages(SID, [MESSAGE]);
    expect(signinTypes()).toEqual([]);
  });

  it('retires an UNRESOLVED card after one turn, reload or not (DOR-1004)', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    signinTurn(store, 1);
    store.setHistoryMessages(SID, [MESSAGE]);

    store.applyEvent(SID, { type: 'turn_start', seq: 5 });
    expect(signinTypes()).toEqual(['mcp_signin_required']);
    store.applyEvent(SID, { type: 'turn_end', seq: 6 });
    store.setHistoryMessages(SID, [MESSAGE]);

    store.applyEvent(SID, { type: 'turn_start', seq: 7 });
    expect(signinTypes()).toEqual([]);
  });

  it('gives the receipt its OWN turn of grace, not the card’s leftovers (DOR-1004)', () => {
    // A sign-in the person takes their time over: the card burns its turn while
    // they are still in the browser, and the resolution lands afterwards. The
    // receipt must not inherit a spent grace and vanish immediately — the server
    // projector resets it in `attachSigninResolution`, and so does this.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    signinTurn(store, 1);
    store.applyEvent(SID, { type: 'turn_start', seq: 5 });
    store.applyEvent(SID, { type: 'turn_end', seq: 6 });

    store.applyEvent(SID, {
      type: 'mcp_signin_resolved',
      seq: 7,
      flowId: 'flow-1',
      outcome: 'connected',
    });
    store.applyEvent(SID, { type: 'turn_start', seq: 8 });

    expect(signinTypes()).toEqual(['mcp_signin_required', 'mcp_signin_resolved']);
  });

  it('a snapshot re-baselines the grace from what the server still carries (DOR-1004)', () => {
    // The server sends only the cards it is still carrying. Keeping a stale
    // spent-mark would retire, on the very next turn, a card the server had just
    // said is on screen.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    signinTurn(store, 1);
    store.applyEvent(SID, { type: 'turn_start', seq: 5 });
    // Grace now spent. A reconnect brings the card back from the server…
    store.applySnapshot(SID, snapshot({ cursor: 10, inProgressTurn: [SIGNIN_REQUIRED(11)] }));

    store.applyEvent(SID, { type: 'turn_start', seq: 12 });

    expect(signinTypes()).toEqual(['mcp_signin_required']);
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
      type: 'operation_progress',
      seq: 3,
      operation: 'compaction',
      state: 'started',
      determinate: false,
      message: 'Compacting context…',
    });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn.map((e) => e.type)).toEqual([
      'turn_start',
      'system_status',
      'operation_progress',
    ]);
  });

  it('retains compact_boundary in the turn so the boundary row is drawn live (DOR-1215)', () => {
    // The same failure `system_status` had above, on the event that matters
    // most: `compact_boundary` was missing from TURN_EVENT_TYPES, so the
    // default arm dropped it and `foldCompactBoundary` — the projection that
    // exists solely to draw `CompactBoundaryRow` (DOR-118) — was never reached
    // by a live turn. The asymmetry that gives it away: a FAILED compaction
    // already drew its row, because that one is synthesized from
    // `operation_progress`, which IS retained. Success drew nothing.
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, {
      type: 'compact_boundary',
      seq: 2,
      trigger: 'manual',
      preTokens: 51_226,
      postTokens: 4_151,
    });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn.map((e) => e.type)).toEqual(['turn_start', 'compact_boundary']);
    // The metadata rides with it — the row reports the numbers, so an event
    // retained but stripped would render a boundary that says nothing.
    expect(s.inProgressTurn[1]).toMatchObject({ trigger: 'manual', preTokens: 51_226 });
  });

  it('retains permission_denied in the turn so the denial chip is drawn live (DOR-795)', () => {
    // Same failure shape `compact_boundary` had: an event the default arm drops
    // never reaches its fold, so the chip only appears on the next history
    // reload — and for a backgrounded subagent's auto-denial there is nothing
    // else in the conversation to notice the loss by.
    useSessionStreamStore.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, {
      type: 'permission_denied',
      seq: 2,
      toolCallId: 'toolu_async_1',
      toolName: 'Bash',
      message: 'Backgrounded agents cannot request permission.',
      reasonType: 'asyncAgent',
      agentId: 'agent_child_7',
    });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn.map((e) => e.type)).toEqual(['turn_start', 'permission_denied']);
    // The attribution rides with it — an event retained but stripped would draw
    // a chip that cannot name the helper it is about.
    expect(s.inProgressTurn[1]).toMatchObject({
      agentId: 'agent_child_7',
      reasonType: 'asyncAgent',
    });
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

  describe('typed turn errors (status.lastError mirror)', () => {
    const errorEvent: SessionEvent = {
      type: 'error',
      seq: 2,
      message: 'Model overloaded',
      code: 'overloaded_error',
      category: 'execution_error',
      details: 'HTTP 529',
    };

    it('an error event rides the turn AND mirrors into status.lastError', () => {
      // Real failure mode: without the mirror, a reconnecting client (whose
      // snapshot carries only status) has no failure details to render — and
      // without the turn push, the live inline error part never folds.
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, errorEvent);
      const s = useSessionStreamStore.getState().getSession(SID);
      expect(s.inProgressTurn.some((e) => e.type === 'error')).toBe(true);
      expect(s.status?.lastError).toEqual({
        message: 'Model overloaded',
        code: 'overloaded_error',
        category: 'execution_error',
        details: 'HTTP 529',
      });
      // Non-terminal: the error event itself must NOT settle the lifecycle.
      expect(s.status?.lifecycle).toBe('streaming');
    });

    it('turn_start clears the previous lastError (server-projector parity)', () => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, errorEvent);
      store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason: 'error' });
      store.applyEvent(SID, { type: 'turn_start', seq: 4 });
      expect(useSessionStreamStore.getState().getSession(SID).status?.lastError).toBeNull();
    });

    it('a turn_end that does not settle to error clears lastError (recovered mid-turn error)', () => {
      // Real failure mode: a runtime that recovers from a mid-turn error (e.g. a
      // Codex item_error) must not leave a stale failure surface behind.
      //
      // The recovered shape carries `completed`, and that is load-bearing: a
      // turn that recovered SAYS so. This drove a reason-less `turn_end` until
      // DOR-1676, which is the CRASH shape rather than the recovered one (the
      // server's mirror of this test always used `completed`), so it asserted
      // idle for a turn that had failed.
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, errorEvent);
      store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason: 'completed' });
      const s = useSessionStreamStore.getState().getSession(SID);
      expect(s.status?.lifecycle).toBe('idle');
      expect(s.status?.lastError).toBeNull();
    });

    // DOR-1676. The gap this closes, on the client half of the mirror: the SDK
    // names its own reason on a failing result, so a turn that emitted a real
    // error frame closed as `turn_end{terminalReason:'model_error'}` — which the
    // old rule recognised as neither an error nor an abort, settling the session
    // idle AND wiping the failure text with it.
    it.each(['model_error', 'api_error', 'turn_setup_failed', 'prompt_too_long', 'max_turns'])(
      'settles to error and keeps lastError when a turn with an error frame ends with %s',
      (terminalReason) => {
        const store = useSessionStreamStore.getState();
        store.applySnapshot(SID, snapshot({ cursor: 0 }));
        store.applyEvent(SID, { type: 'turn_start', seq: 1 });
        store.applyEvent(SID, errorEvent);
        store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason });
        const s = useSessionStreamStore.getState().getSession(SID);
        expect(s.status?.lifecycle).toBe('error');
        expect(s.status?.lastError?.message).toBe('Model overloaded');
      }
    );

    // The absolving half, and the reason it is an allowlist rather than just
    // `completed`: these three ride the SDK's success result — the turn handed
    // work off and is coming back (the DOR-1100 continuation). Failing them
    // would call a turn that is still working a turn that broke.
    it.each(['background_requested', 'tool_deferred', 'tool_deferred_unavailable'])(
      'stays idle when an error frame is excused by %s',
      (terminalReason) => {
        const store = useSessionStreamStore.getState();
        store.applySnapshot(SID, snapshot({ cursor: 0 }));
        store.applyEvent(SID, { type: 'turn_start', seq: 1 });
        store.applyEvent(SID, errorEvent);
        store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason });
        expect(useSessionStreamStore.getState().getSession(SID).status?.lifecycle).toBe('idle');
      }
    );

    // A survivable error is not the turn failing: a `hook_failure` is the
    // operator's own script exiting non-zero, and the turn still carried the
    // whole answer. Without the denylist the frame rule would fail it.
    it('stays idle when the only error frame is a non-fatal hook failure', () => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, {
        type: 'error',
        seq: 2,
        message: 'Hook "notify" failed (Stop)',
        code: 'hook_failure',
      });
      store.applyEvent(SID, { type: 'turn_end', seq: 3 });
      expect(useSessionStreamStore.getState().getSession(SID).status?.lifecycle).toBe('idle');
    });

    // A stop outranks the frame. The claude-code mapper deliberately KEEPS an
    // error frame on an abort nobody asked for (DOR-1320), so the frame rule
    // must not turn every such turn into a crash — cut short is its own answer.
    it('settles to interrupted, not error, when an aborted turn carried an error frame', () => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, errorEvent);
      store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason: 'aborted_streaming' });
      expect(useSessionStreamStore.getState().getSession(SID).status?.lifecycle).toBe(
        'interrupted'
      );
    });

    // Real failure mode, and it reached main's own send tests before this guard
    // existed. `status_change.status` is `.partial()`, so a delta can carry one
    // field — and `mergeStatus` used to fall back to that delta itself when no
    // snapshot had hydrated yet ("prior is non-null in practice"), leaving a
    // held status with no `lastError` key at all. `lastError` is typed
    // `ErrorEvent | null`, so a `!== null` test LOOKED total; reading `.code`
    // off nothing THREW inside the projection, and an ordinary turn ending
    // stopped settling — the session stayed `streaming` and the composer stayed
    // locked. The root fix is that the held status is a WHOLE `SessionStatus`
    // from the first event on, so the fields the derivation reads
    // unconditionally are all there.
    //
    // Deliberately applies NO snapshot, because that is the whole reproduction.
    it('settles a turn whose held status was built by a status_change alone (no snapshot yet)', () => {
      const store = useSessionStreamStore.getState();
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, {
        type: 'status_change',
        seq: 2,
        status: { lifecycle: 'streaming', permissionMode: 'default' },
      });
      expect(useSessionStreamStore.getState().getSession(SID).status?.lastError).toBeNull();

      store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason: 'model_error' });
      const s = useSessionStreamStore.getState().getSession(SID);
      expect(s.status?.lifecycle).toBe('idle');
      expect(s.status?.lastError).toBeNull();
      expect(s.status?.cost).toBeNull();
    });

    // The second defense, kept because the first cannot reach every source of a
    // missing key: a snapshot minted by a server that predates `lastError`
    // hydrates status WHOLESALE, so `mergeStatus` never sees it and the field is
    // structurally absent however complete the store's own base is. The
    // derivation therefore reads `lastError` truthily rather than `!== null`.
    it('settles a turn hydrated from a snapshot whose status predates lastError', () => {
      const store = useSessionStreamStore.getState();
      const { lastError: _omitted, ...withoutLastError } = STATUS;
      store.applySnapshot(SID, snapshot({ cursor: 0, status: withoutLastError as SessionStatus }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, { type: 'turn_end', seq: 2, terminalReason: 'model_error' });
      expect(useSessionStreamStore.getState().getSession(SID).status?.lifecycle).toBe('idle');
    });

    // The frame is what decides, so a clean turn must not be dragged into error
    // by an unfamiliar reason. A forward-open union means new SDK values arrive
    // without warning, and one of them accusing a turn that reported nothing
    // wrong would be the mirror-image bug.
    it('stays idle for an unclassified terminal reason when no error frame was latched', () => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, { type: 'turn_end', seq: 2, terminalReason: 'some_future_reason' });
      expect(useSessionStreamStore.getState().getSession(SID).status?.lifecycle).toBe('idle');
    });

    it('a turn_end that settles to error retains lastError', () => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, errorEvent);
      store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason: 'error' });
      const s = useSessionStreamStore.getState().getSession(SID);
      expect(s.status?.lifecycle).toBe('error');
      expect(s.status?.lastError?.message).toBe('Model overloaded');
    });

    it('snapshot hydration carries lastError (reconnect after a failed turn)', () => {
      const held = { message: 'Sidecar crashed', category: 'execution_error' as const };
      useSessionStreamStore
        .getState()
        .applySnapshot(
          SID,
          snapshot({ status: { ...STATUS, lifecycle: 'error', lastError: held } })
        );
      expect(useSessionStreamStore.getState().getSession(SID).status?.lastError).toEqual(held);
    });
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

    it('is idempotent — the second observation point finds an empty source and no-ops', () => {
      // Both the 202 path and the retire announce may fire for one rekey.
      const store = useSessionStreamStore.getState();
      store.setOptimisticUserMessage('request-uuid', { id: 'opt-1', content: 'once' });
      store.migrateSessionContinuity('request-uuid', 'canonical-id');
      store.setOptimisticUserMessage('canonical-id', { id: 'opt-1', content: 'once' });
      store.migrateSessionContinuity('request-uuid', 'canonical-id');
      expect(
        useSessionStreamStore.getState().getSession('canonical-id').optimisticUserMessage
      ).toEqual({ id: 'opt-1', content: 'once' });
    });

    it('no-ops on an identity migration and never creates an entry for an empty source', () => {
      const store = useSessionStreamStore.getState();
      store.setOptimisticUserMessage(SID, { id: 'opt-1', content: 'kept' });
      store.migrateSessionContinuity(SID, SID);
      expect(useSessionStreamStore.getState().getSession(SID).optimisticUserMessage).not.toBeNull();
      store.migrateSessionContinuity('never-seen', 'canonical-id');
      expect(useSessionStreamStore.getState().sessions['canonical-id']).toBeUndefined();
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

    it('unpinning makes the session evictable again on the next over-limit pass', () => {
      const store = useSessionStreamStore.getState();
      seedIdleSessions(store, RETENTION_LIMIT);
      store.setPinnedSession('s-0');
      store.ensureSession('s-20'); // survives, still pinned

      store.setPinnedSession(null);
      store.ensureSession('s-21'); // one more over-limit pass, now unpinned

      const after = useSessionStreamStore.getState();
      expect(after.sessions['s-0']).toBeUndefined();
      expect(after.sessionAccessOrder).not.toContain('s-0');
    });

    it('setPinnedSession updates pinnedSessionId, and clears it back to null', () => {
      expect(useSessionStreamStore.getState().pinnedSessionId).toBeNull();
      useSessionStreamStore.getState().setPinnedSession(SID);
      expect(useSessionStreamStore.getState().pinnedSessionId).toBe(SID);
      useSessionStreamStore.getState().setPinnedSession(null);
      expect(useSessionStreamStore.getState().pinnedSessionId).toBeNull();
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

  describe("queue_update (the server's queue, projected)", () => {
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

    it('an out-of-order or duplicate update is ignored, like every other event', () => {
      const store = useSessionStreamStore.getState();
      store.applyEvent(SID, queueUpdate(4, [queued('q1', 'current')]));
      store.applyEvent(SID, queueUpdate(2, []));
      expect(useSessionStreamStore.getState().getSession(SID).queuedMessages).toHaveLength(1);
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

    it('drops the receipt when its message leaves the queue', () => {
      const store = useSessionStreamStore.getState();
      store.applyEvent(
        SID,
        queueUpdate(1, [queued('q1', 'change course')], {
          messageId: 'q1',
          requested: 'steer',
          applied: 'queue',
          degradedBecause: 'unsupported',
        })
      );
      store.applyEvent(SID, queueUpdate(2, []));
      expect(useSessionStreamStore.getState().getSession(SID).queueOutcomes).toEqual({});
    });

    it('keeps no receipt for a message that ran instead of queueing', () => {
      // An outcome can name a message that is already absent from the queue —
      // it ran straight away. There is no chip for it, so there is nothing to
      // hang a receipt on.
      useSessionStreamStore.getState().applyEvent(
        SID,
        queueUpdate(1, [], {
          messageId: 'q1',
          requested: 'steer',
          applied: 'queue',
          degradedBecause: 'session-idle',
        })
      );
      expect(useSessionStreamStore.getState().getSession(SID).queueOutcomes).toEqual({});
    });

    it('a fresh snapshot replaces the queue and clears the receipts', () => {
      const store = useSessionStreamStore.getState();
      store.applyEvent(
        SID,
        queueUpdate(1, [queued('q1', 'waiting')], {
          messageId: 'q1',
          requested: 'queue',
          applied: 'queue',
        })
      );
      store.applySnapshot(SID, snapshot({ queuedMessages: [queued('q2', 'from the server')] }));
      const after = useSessionStreamStore.getState().getSession(SID);
      expect(after.queuedMessages.map((m) => m.id)).toEqual(['q2']);
      expect(after.queueOutcomes).toEqual({});
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
    runtime: 'claude-code',
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

// DOR-1100: a background task outlives the turn that started it, so the count
// this store reports has to outlive that turn's events. The turn-end reconcile
// wipes `inProgressTurn` seconds after the turn closes, which is exactly when
// the session looks finished and is not.
describe('useSessionStreamStore — live background children', () => {
  const store = useSessionStreamStore;

  /** A `subagent_update` on the durable stream. */
  function child(seq: number, taskId: string, status: string): SessionEvent {
    return { type: 'subagent_update', seq, taskId, status } as SessionEvent;
  }

  beforeEach(() => {
    store.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
  });

  it('keeps the count after the turn that started the children is reloaded away', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.getState().applyEvent(SID, child(2, 'bt1', 'running'));
    store.getState().applyEvent(SID, child(3, 'bt2', 'running'));
    store.getState().applyEvent(SID, { type: 'turn_end', seq: 4 });
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(2);

    // What the turn-end reconcile does: canonical history replaces the turn.
    store.getState().setHistoryMessages(SID, [MESSAGE]);

    expect(store.getState().sessions[SID]?.inProgressTurn).toEqual([]);
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(2);
    expect(store.getState().sessions[SID]?.status?.lifecycle).toBe('idle');
  });

  it('does not double-count a child that keeps reporting progress', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, child(1, 'bt1', 'running'));
    store.getState().applyEvent(SID, child(2, 'bt1', 'running'));
    store.getState().applyEvent(SID, child(3, 'bt1', 'running'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(1);
  });

  it('drops a child from the count when it finishes', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, child(1, 'bt1', 'running'));
    store.getState().applyEvent(SID, child(2, 'bt2', 'running'));
    store.getState().applyEvent(SID, child(3, 'bt1', 'complete'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(1);
    store.getState().applyEvent(SID, child(4, 'bt2', 'error'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(0);
  });

  // A refresh mid-background-work: the snapshot counts two children and names
  // neither (they belong to a turn that already closed). Both facts have to
  // survive — the total, and the fact that finishing one leaves one.
  it('carries a snapshot count for children it cannot name, and drains it', () => {
    store.getState().applySnapshot(
      SID,
      snapshot({
        cursor: 10,
        status: { ...STATUS, runningSubagentCount: 2 },
      })
    );
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(2);
    expect(store.getState().sessions[SID]?.unnamedRunningSubagents).toBe(2);

    store.getState().applyEvent(SID, child(11, 'bt-from-before', 'complete'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(1);

    // A child this projection CAN name starts alongside them.
    store.getState().applyEvent(SID, child(12, 'bt-new', 'running'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(2);
    store.getState().applyEvent(SID, child(13, 'bt-new', 'complete'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(1);
  });

  // The snapshot names what it can, so a child already visible in the current
  // turn must not be counted twice when its next progress report arrives.
  it('names the snapshot turn’s running children instead of counting them twice', () => {
    store.getState().applySnapshot(
      SID,
      snapshot({
        cursor: 10,
        status: { ...STATUS, runningSubagentCount: 1 },
        inProgressTurn: [{ type: 'turn_start', seq: 8 }, child(9, 'bt1', 'running')],
      })
    );
    expect(store.getState().sessions[SID]?.runningSubagentIds).toEqual(['bt1']);
    expect(store.getState().sessions[SID]?.unnamedRunningSubagents).toBe(0);

    store.getState().applyEvent(SID, child(11, 'bt1', 'running'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(1);
  });
});

// A turn window the RUNTIME opened (DOR-1100) — the agent waking itself up when
// a background task finished — is not the same thing as the person sending the
// next message, and the projection must not treat it as one.
describe('useSessionStreamStore — runtime-opened turn windows', () => {
  const store = useSessionStreamStore;

  beforeEach(() => {
    store.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
  });

  // The failure this replaces: the CLI drains its queued notification within
  // milliseconds, so the reopen routinely beats the turn-end history reload.
  // Resetting the turn there blanked the reply the agent had just written.
  it('keeps the finished window’s events on screen when the agent wakes itself', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.getState().applyEvent(SID, { type: 'text_delta', seq: 2, text: 'here is the answer' });
    store.getState().applyEvent(SID, { type: 'turn_end', seq: 3 });
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 4, origin: 'runtime' });
    store.getState().applyEvent(SID, { type: 'text_delta', seq: 5, text: 'and one more thing' });

    // `turn_end` itself is never pushed onto the turn (server parity), so the
    // preserved shape is the finished window's CONTENT followed by the new
    // window's — which is exactly what stays on screen.
    expect(store.getState().sessions[SID]?.inProgressTurn.map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'turn_start',
      'text_delta',
    ]);
    expect(
      store.getState().sessions[SID]?.inProgressTurn.find((e) => e.type === 'text_delta')
    ).toMatchObject({ text: 'here is the answer' });
    expect(store.getState().sessions[SID]?.status?.lifecycle).toBe('streaming');
  });

  // A turn the PERSON sends still resets: by then the settled turn has long
  // since been reloaded into canonical history, so keeping it would double it.
  it('still resets the turn when a person sends the next message', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.getState().applyEvent(SID, { type: 'text_delta', seq: 2, text: 'first' });
    store.getState().applyEvent(SID, { type: 'turn_end', seq: 3 });
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 4, userMessage: 'again please' });

    expect(store.getState().sessions[SID]?.inProgressTurn.map((e) => e.type)).toEqual([
      'turn_start',
    ]);
  });

  // A chain of wake-ups appends without bound if no reload lands to trim it, and
  // a long-lived tab must not grow forever. The trim takes whole finished
  // windows: half a window renders as a reply starting mid-sentence.
  it('bounds a long wake-up chain by dropping whole finished windows', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    let seq = 0;
    const next = () => ++seq;
    store.getState().applyEvent(SID, { type: 'turn_start', seq: next() });
    // Ten wake-up windows of 40 deltas each — well past the 200 bound.
    for (let window = 0; window < 10; window++) {
      store.getState().applyEvent(SID, { type: 'turn_end', seq: next() });
      store.getState().applyEvent(SID, { type: 'turn_start', seq: next(), origin: 'runtime' });
      for (let i = 0; i < 40; i++) {
        store.getState().applyEvent(SID, { type: 'text_delta', seq: next(), text: `w${window}` });
      }
    }

    const turn = store.getState().sessions[SID]!.inProgressTurn;
    expect(turn.length).toBeLessThanOrEqual(200);
    // Whatever survived still begins at a window boundary, never mid-reply.
    expect(turn[0]?.type).toBe('turn_start');
    // …and the newest window is intact, which is the one on screen.
    expect(turn.filter((e) => e.type === 'text_delta').at(-1)).toMatchObject({ text: 'w9' });
  });

  // The bound's blind spot (DOR-1107): a retained sign-in card sits AHEAD of the
  // first window, so a scan that assumed the turn began at a window boundary cut
  // nothing off, and the cap stopped applying for the rest of the session.
  it('bounds a long wake-up chain that begins with a retained sign-in card', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    let seq = 0;
    const next = () => ++seq;

    // A turn asks for a sign-in, ends, and its history reload lands — which
    // clears the turn down to the one thing the transcript never carries: the
    // unresolved card. That card is now the turn's first event.
    store.getState().applyEvent(SID, { type: 'turn_start', seq: next() });
    store.getState().applyEvent(SID, {
      type: 'mcp_signin_required',
      seq: next(),
      serverName: 'granola',
      agentId: '01HV7KJZZZ0000000000000000',
      flowId: 'flow-1',
      authorizeUrl: 'https://mcp.test.local/authorize',
      disclosure: 'DorkOS stores the token on this machine.',
    });
    store.getState().applyEvent(SID, { type: 'turn_end', seq: next() });
    store.getState().setHistoryMessages(SID, [MESSAGE]);
    expect(store.getState().sessions[SID]?.inProgressTurn.map((e) => e.type)).toEqual([
      'mcp_signin_required',
    ]);

    // The person is off in their browser, so nothing ages the card and no reload
    // trims the turn. A hundred wake-up windows append behind it.
    for (let window = 0; window < 100; window++) {
      store.getState().applyEvent(SID, { type: 'turn_start', seq: next(), origin: 'runtime' });
      for (let i = 0; i < 5; i++) {
        store.getState().applyEvent(SID, { type: 'text_delta', seq: next(), text: `w${window}` });
      }
      store.getState().applyEvent(SID, { type: 'turn_end', seq: next() });
    }

    const turn = store.getState().sessions[SID]!.inProgressTurn;
    expect(turn.length).toBeLessThanOrEqual(200);
    // The card is still there — bounding the turn must not cost the person the
    // link they walked away to use (DOR-1004).
    expect(turn[0]?.type).toBe('mcp_signin_required');
    // …and what survives behind it still starts at a window boundary.
    expect(turn[1]?.type).toBe('turn_start');
    expect(turn.filter((e) => e.type === 'text_delta').at(-1)).toMatchObject({ text: 'w99' });
  });

  it('records who opened the window so the settle handler can tell them apart', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 1 });
    expect(store.getState().sessions[SID]?.turnOrigin).toBe('user');

    store.getState().applyEvent(SID, { type: 'turn_end', seq: 2 });
    // Survives turn_end: the settle handler runs after it and needs to know
    // what just settled.
    expect(store.getState().sessions[SID]?.turnOrigin).toBe('user');

    store.getState().applyEvent(SID, { type: 'turn_start', seq: 3, origin: 'runtime' });
    expect(store.getState().sessions[SID]?.turnOrigin).toBe('runtime');
  });
});
