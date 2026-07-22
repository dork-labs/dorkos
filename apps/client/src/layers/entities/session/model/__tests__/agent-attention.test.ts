/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SessionStatus, SessionLifecycle } from '@dorkos/shared/session-stream';
import type { RecentSessionsResponse } from '@dorkos/shared/types';

interface FakeListState {
  statusCwds: Record<string, string>;
  statuses: Record<string, SessionStatus>;
}

let fakeListState: FakeListState;
let fakeAgentActivity: Record<string, string>;

// Mock the global store + the recency query so both correctness and the
// single-subscription invariant are deterministic — mirrors the pattern in
// use-agents-aggregate-status.test.tsx.
vi.mock('../session-list-store', () => ({
  useSessionListStore: vi.fn((selector: (s: FakeListState) => unknown) => selector(fakeListState)),
}));

vi.mock('../use-recent-sessions', () => ({
  useRecentSessions: vi.fn(
    () =>
      ({
        data: {
          sessions: [],
          agentActivity: fakeAgentActivity,
          warnings: [],
        } satisfies RecentSessionsResponse,
      }) as { data: RecentSessionsResponse }
  ),
}));

import { useSessionListStore } from '../session-list-store';
import {
  deriveAttention,
  foldLiveKindsByPath,
  useAgentAttentionMap,
  ATTENTION_THRESHOLDS,
  type LiveBorderKind,
} from '../agent-attention';

const A = '/work/alpha';
const B = '/work/beta';

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
  fakeListState.statusCwds[sessionId] = cwd;
  fakeListState.statuses[sessionId] = statusWithLifecycle(lifecycle);
}

describe('deriveAttention', () => {
  const now = 1_800_000_000_000;

  it('returns needs-attention when a live kind includes pendingApproval', () => {
    expect(deriveAttention({ liveKinds: ['pendingApproval'], lastActivityAt: null, now })).toBe(
      'needs-attention'
    );
  });

  it('returns needs-attention when a live kind includes error (the blocked/error kind distinct from pendingApproval)', () => {
    expect(deriveAttention({ liveKinds: ['error'], lastActivityAt: null, now })).toBe(
      'needs-attention'
    );
  });

  it('needs-attention wins over a simultaneous streaming kind', () => {
    expect(
      deriveAttention({ liveKinds: ['streaming', 'pendingApproval'], lastActivityAt: null, now })
    ).toBe('needs-attention');
  });

  it('returns active when streaming, regardless of recency', () => {
    expect(
      deriveAttention({ liveKinds: ['streaming'], lastActivityAt: now - 1_000_000_000, now })
    ).toBe('active');
  });

  it('returns fresh when there is no live kind and no activity ever (a brand-new agent)', () => {
    expect(deriveAttention({ liveKinds: [], lastActivityAt: null, now })).toBe('fresh');
  });

  it('returns active exactly at the active-within boundary (inclusive)', () => {
    const lastActivityAt = now - ATTENTION_THRESHOLDS.activeWithinMs;
    expect(deriveAttention({ liveKinds: [], lastActivityAt, now })).toBe('active');
  });

  it('returns idle just past the active-within boundary', () => {
    const lastActivityAt = now - ATTENTION_THRESHOLDS.activeWithinMs - 1;
    expect(deriveAttention({ liveKinds: [], lastActivityAt, now })).toBe('idle');
  });

  it('returns idle exactly at the inactive-after boundary (inclusive)', () => {
    const lastActivityAt = now - ATTENTION_THRESHOLDS.inactiveAfterMs;
    expect(deriveAttention({ liveKinds: [], lastActivityAt, now })).toBe('idle');
  });

  it('returns inactive just past the inactive-after boundary (dormant, had activity once)', () => {
    const lastActivityAt = now - ATTENTION_THRESHOLDS.inactiveAfterMs - 1;
    expect(deriveAttention({ liveKinds: [], lastActivityAt, now })).toBe('inactive');
  });
});

describe('foldLiveKindsByPath', () => {
  it('groups multiple sessions per path and skips paths outside the set', () => {
    const statusCwds = { s1: A, s2: A, s3: B };
    const statuses: Record<string, SessionStatus> = {
      s1: statusWithLifecycle('streaming'),
      s2: statusWithLifecycle('blocked'),
      s3: statusWithLifecycle('streaming'),
    };
    const folded = foldLiveKindsByPath(statusCwds, statuses, new Set([A]));
    expect(folded.get(A)).toEqual<LiveBorderKind[]>(['streaming', 'pendingApproval']);
    expect(folded.has(B)).toBe(false);
  });

  it('skips sessions with no actionable lifecycle', () => {
    const statusCwds = { s1: A };
    const statuses: Record<string, SessionStatus> = { s1: statusWithLifecycle('idle') };
    const folded = foldLiveKindsByPath(statusCwds, statuses, new Set([A]));
    expect(folded.has(A)).toBe(false);
  });

  it('returns an empty map for an empty path set', () => {
    const folded = foldLiveKindsByPath(
      { s1: A },
      { s1: statusWithLifecycle('streaming') },
      new Set()
    );
    expect(folded.size).toBe(0);
  });
});

describe('useAgentAttentionMap', () => {
  beforeEach(() => {
    fakeListState = { statusCwds: {}, statuses: {} };
    fakeAgentActivity = {};
    vi.mocked(useSessionListStore).mockClear();
  });

  it('is needs-attention for a path with a live pendingApproval session, fresh for a never-active one', () => {
    work('s1', 'blocked', A);
    const { result } = renderHook(() => useAgentAttentionMap([A, B]));
    expect(result.current[A]).toBe('needs-attention');
    expect(result.current[B]).toBe('fresh');
  });

  it('is active for a path with a live streaming session', () => {
    work('s1', 'streaming', A);
    const { result } = renderHook(() => useAgentAttentionMap([A]));
    expect(result.current[A]).toBe('active');
  });

  it('takes the hottest state across multiple sessions for one path', () => {
    work('s1', 'idle', A);
    work('s2', 'blocked', A);
    const { result } = renderHook(() => useAgentAttentionMap([A]));
    expect(result.current[A]).toBe('needs-attention');
  });

  it('falls through to recency when there is no live session', () => {
    fakeAgentActivity[A] = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const { result } = renderHook(() => useAgentAttentionMap([A]));
    expect(result.current[A]).toBe('active');
  });

  it('is fresh for a path with no live session and no recorded activity ever', () => {
    const { result } = renderHook(() => useAgentAttentionMap([A]));
    expect(result.current[A]).toBe('fresh');
  });

  it('uses one aggregated subscription independent of path count', () => {
    const { unmount } = renderHook(() => useAgentAttentionMap([A, B]));
    const callsForTwo = vi.mocked(useSessionListStore).mock.calls.length;
    unmount();
    vi.mocked(useSessionListStore).mockClear();

    renderHook(() => useAgentAttentionMap(Array.from({ length: 50 }, (_, i) => `/p/${i}`)));
    const callsForFifty = vi.mocked(useSessionListStore).mock.calls.length;

    expect(callsForFifty).toBe(callsForTwo);
  });
});
