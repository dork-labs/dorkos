/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SessionStatus, SessionLifecycle } from '@dorkos/shared/session-stream';

interface FakeState {
  statusCwds: Record<string, string>;
  statuses: Record<string, SessionStatus>;
}

let fakeState: FakeState;

// Mock the global store so both correctness and the single-subscription
// invariant (one `useSessionListStore` call regardless of member count) are
// deterministic — zustand binds its real `subscribe` internally, so a spy on
// the store can't observe the subscription count.
vi.mock('../session-list-store', () => ({
  useSessionListStore: vi.fn((selector: (s: FakeState) => unknown) => selector(fakeState)),
}));

import { useSessionListStore } from '../session-list-store';
import { useAgentsAggregateStatus } from '../use-agents-aggregate-status';

const A = '/work/alpha';
const B = '/work/beta';
const C = '/work/gamma';

function statusWithLifecycle(lifecycle: SessionLifecycle): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle,
    lastError: null,
  };
}

/** Seed one live session for `cwd` with the given lifecycle. */
function work(sessionId: string, lifecycle: SessionLifecycle, cwd: string) {
  fakeState.statusCwds[sessionId] = cwd;
  fakeState.statuses[sessionId] = statusWithLifecycle(lifecycle);
}

describe('useAgentsAggregateStatus', () => {
  beforeEach(() => {
    fakeState = { statusCwds: {}, statuses: {} };
    vi.mocked(useSessionListStore).mockClear();
  });

  it('is false when no member is working', () => {
    const { result } = renderHook(() => useAgentsAggregateStatus([A, B]));
    expect(result.current).toBe(false);
  });

  it('is true when any member path is streaming', () => {
    work('s1', 'streaming', B);
    const { result } = renderHook(() => useAgentsAggregateStatus([A, B]));
    expect(result.current).toBe(true);
  });

  it('is true when a member is awaiting approval (blocked)', () => {
    work('s1', 'blocked', A);
    const { result } = renderHook(() => useAgentsAggregateStatus([A, B]));
    expect(result.current).toBe(true);
  });

  it('ignores work from paths outside the set', () => {
    work('s1', 'streaming', C);
    const { result } = renderHook(() => useAgentsAggregateStatus([A, B]));
    expect(result.current).toBe(false);
  });

  it('is empty-safe', () => {
    work('s1', 'streaming', A);
    const { result } = renderHook(() => useAgentsAggregateStatus([]));
    expect(result.current).toBe(false);
  });

  it('uses one aggregated subscription independent of member count', () => {
    const { unmount } = renderHook(() => useAgentsAggregateStatus([A, B]));
    const callsForTwo = vi.mocked(useSessionListStore).mock.calls.length;
    unmount();
    vi.mocked(useSessionListStore).mockClear();

    renderHook(() => useAgentsAggregateStatus(Array.from({ length: 50 }, (_, i) => `/p/${i}`)));
    const callsForFifty = vi.mocked(useSessionListStore).mock.calls.length;

    // The store hook is invoked the same number of times for 2 vs 50 members —
    // O(1) subscriptions, not one per hidden member.
    expect(callsForFifty).toBe(callsForTwo);
  });
});
