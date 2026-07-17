import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionStatus, SessionContextUsage } from '@dorkos/shared/session-stream';
import { useSessionListStore } from '../session-list-store';

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
