import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionStatus, SessionContextUsage } from '@dorkos/shared/session-stream';
import { useSessionListStore, selectSessionActivity } from '../session-list-store';

const CONTEXT: SessionContextUsage = {
  totalTokens: 120_000,
  maxTokens: 200_000,
  outputTokens: 1_000,
  cacheReadTokens: 500,
  cacheCreationTokens: 200,
};

function status(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    contextUsage: CONTEXT,
    cost: null,
    usage: null,
    cacheStats: null,
    model: 'claude-opus-4-6',
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle: 'streaming',
    lastError: null,
    ...overrides,
  };
}

function resetStore() {
  useSessionListStore.setState({
    sessions: {},
    statuses: {},
    statusCwds: {},
    contextReadings: {},
    unseen: {},
    rekeys: {},
  });
}

describe('session-list-store contextReadings retention (fleet-context-health)', () => {
  beforeEach(resetStore);

  it('populates contextReadings from a session_status carrying contextUsage', () => {
    // Purpose: a live reading must land in the retained map so the merge
    // resolver can prefer it over the list reading (live wins).
    useSessionListStore.getState().applyListEvent({
      type: 'session_status',
      sessionId: 's1',
      status: status(),
    });

    const reading = useSessionListStore.getState().contextReadings['s1'];
    expect(reading?.contextUsage).toEqual(CONTEXT);
    expect(typeof reading?.receivedAt).toBe('string');
  });

  it('retains the reading after settle (idle) while pruning the liveness status', () => {
    // Purpose: Decision 3 — a settling status prunes the liveness/border signal
    // but the retained reading survives, so a background session keeps its last
    // known usage. The idle event carries no contextUsage, so the surviving
    // reading is provably the earlier streaming one, not a re-set.
    const store = useSessionListStore.getState();
    store.applyListEvent({ type: 'session_status', sessionId: 's1', status: status() });
    store.applyListEvent({
      type: 'session_status',
      sessionId: 's1',
      status: status({ lifecycle: 'idle', contextUsage: null }),
    });

    const state = useSessionListStore.getState();
    expect(state.statuses['s1']).toBeUndefined();
    expect(state.statusCwds['s1']).toBeUndefined();
    expect(state.contextReadings['s1']?.contextUsage).toEqual(CONTEXT);
  });

  it('clears the reading on session_removed', () => {
    // Purpose: a deleted transcript drops its reading — no dangling entry.
    const store = useSessionListStore.getState();
    store.applyListEvent({ type: 'session_status', sessionId: 's1', status: status() });
    store.applyListEvent({ type: 'session_removed', sessionId: 's1' });

    expect(useSessionListStore.getState().contextReadings['s1']).toBeUndefined();
  });

  it('clears the retired id reading on a rekey re-announce (retiredSessionId)', () => {
    // Purpose: the pre-rekey request UUID can never become active again, so its
    // reading must be dropped when the canonical id supersedes it.
    const store = useSessionListStore.getState();
    store.applyListEvent({ type: 'session_status', sessionId: 'old-id', status: status() });
    store.applyListEvent({
      type: 'session_status',
      sessionId: 'new-id',
      retiredSessionId: 'old-id',
      status: status(),
    });

    const state = useSessionListStore.getState();
    expect(state.contextReadings['old-id']).toBeUndefined();
    expect(state.contextReadings['new-id']?.contextUsage).toEqual(CONTEXT);
  });

  it('clears every reading on resetStatuses (stream reconnect)', () => {
    // Purpose: a reading held across a disconnect could be stale after a server
    // restart, so reconnect wipes them the same way it wipes statuses.
    const store = useSessionListStore.getState();
    store.applyListEvent({ type: 'session_status', sessionId: 's1', status: status() });
    store.applyListEvent({ type: 'session_status', sessionId: 's2', status: status() });
    store.resetStatuses();

    expect(useSessionListStore.getState().contextReadings).toEqual({});
  });
});

describe('session-list-store activity (DOR-1053)', () => {
  beforeEach(resetStore);

  it('holds what each session is doing, keyed by session', () => {
    // Purpose: the fleet reading has to be readable per session by anything on
    // the page — the chat strip today, a sidebar row next — off the one store
    // the global stream already feeds.
    const store = useSessionListStore.getState();
    store.applyListEvent({
      type: 'session_status',
      sessionId: 's1',
      status: status({ activity: { toolName: 'Edit', target: 'router.tsx' } }),
    });
    store.applyListEvent({
      type: 'session_status',
      sessionId: 's2',
      status: status({ activity: { toolName: 'Bash', target: 'pnpm verify' } }),
    });

    expect(selectSessionActivity(useSessionListStore.getState(), 's1')).toEqual({
      toolName: 'Edit',
      target: 'router.tsx',
    });
    expect(selectSessionActivity(useSessionListStore.getState(), 's2')).toEqual({
      toolName: 'Bash',
      target: 'pnpm verify',
    });
  });

  it('forgets it the moment the session settles', () => {
    // Purpose: an idle session is not doing anything, and a label that outlives
    // its turn is the failure this exists to prevent. The settle prunes the
    // whole status, so the reading cannot survive it.
    const store = useSessionListStore.getState();
    store.applyListEvent({
      type: 'session_status',
      sessionId: 's1',
      status: status({ activity: { toolName: 'Bash', target: 'pnpm verify' } }),
    });
    expect(selectSessionActivity(useSessionListStore.getState(), 's1')).not.toBeNull();

    store.applyListEvent({
      type: 'session_status',
      sessionId: 's1',
      status: status({ lifecycle: 'idle', contextUsage: null }),
    });
    expect(selectSessionActivity(useSessionListStore.getState(), 's1')).toBeNull();
  });

  it('reads null for a session that is streaming but has reached no tool', () => {
    // Purpose: absent must read as "nothing known", which is the input the
    // client ladder degrades to "Working…" on.
    useSessionListStore.getState().applyListEvent({
      type: 'session_status',
      sessionId: 's1',
      status: status(),
    });
    expect(selectSessionActivity(useSessionListStore.getState(), 's1')).toBeNull();
    expect(selectSessionActivity(useSessionListStore.getState(), 'never-seen')).toBeNull();
  });

  it('drops it with the session it belonged to, and on a stream reconnect', () => {
    const store = useSessionListStore.getState();
    const streaming = {
      type: 'session_status' as const,
      sessionId: 's1',
      status: status({ activity: { toolName: 'Bash', target: 'pnpm verify' } }),
    };

    store.applyListEvent(streaming);
    store.applyListEvent({ type: 'session_removed', sessionId: 's1' });
    expect(selectSessionActivity(useSessionListStore.getState(), 's1')).toBeNull();

    store.applyListEvent(streaming);
    store.resetStatuses();
    expect(selectSessionActivity(useSessionListStore.getState(), 's1')).toBeNull();
  });
});
