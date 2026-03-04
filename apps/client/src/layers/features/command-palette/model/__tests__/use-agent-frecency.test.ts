/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { calcFrecencyScore } from '../use-agent-frecency';
import type { FrecencyRecord } from '../use-agent-frecency';

let store: Record<string, string> = {};
beforeEach(() => {
  store = {};
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => store[key] ?? null);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => {
    store[key] = val;
  });
});

describe('calcFrecencyScore', () => {
  const NOW = 1709500000000;

  it('returns 0 for empty timestamps', () => {
    const record: FrecencyRecord = { agentId: 'a', timestamps: [], totalCount: 5 };
    expect(calcFrecencyScore(record, NOW)).toBe(0);
  });

  it('gives 100 points for timestamps within 4 hours', () => {
    const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
    const record: FrecencyRecord = { agentId: 'a', timestamps: [twoHoursAgo], totalCount: 1 };
    expect(calcFrecencyScore(record, NOW)).toBe(100);
  });

  it('gives 80 points for timestamps within 24 hours', () => {
    const twelveHoursAgo = NOW - 12 * 60 * 60 * 1000;
    const record: FrecencyRecord = { agentId: 'a', timestamps: [twelveHoursAgo], totalCount: 1 };
    expect(calcFrecencyScore(record, NOW)).toBe(80);
  });

  it('gives 60 points for timestamps within 3 days', () => {
    const twoDaysAgo = NOW - 2 * 24 * 60 * 60 * 1000;
    const record: FrecencyRecord = { agentId: 'a', timestamps: [twoDaysAgo], totalCount: 1 };
    expect(calcFrecencyScore(record, NOW)).toBe(60);
  });

  it('gives 40 points for timestamps within 1 week', () => {
    const fiveDaysAgo = NOW - 5 * 24 * 60 * 60 * 1000;
    const record: FrecencyRecord = { agentId: 'a', timestamps: [fiveDaysAgo], totalCount: 1 };
    expect(calcFrecencyScore(record, NOW)).toBe(40);
  });

  it('gives 20 points for timestamps within 1 month', () => {
    const twoWeeksAgo = NOW - 14 * 24 * 60 * 60 * 1000;
    const record: FrecencyRecord = { agentId: 'a', timestamps: [twoWeeksAgo], totalCount: 1 };
    expect(calcFrecencyScore(record, NOW)).toBe(20);
  });

  it('gives 10 points for timestamps within 90 days', () => {
    const sixtyDaysAgo = NOW - 60 * 24 * 60 * 60 * 1000;
    const record: FrecencyRecord = { agentId: 'a', timestamps: [sixtyDaysAgo], totalCount: 1 };
    expect(calcFrecencyScore(record, NOW)).toBe(10);
  });

  it('gives 0 points for timestamps beyond 90 days', () => {
    const oneHundredDaysAgo = NOW - 100 * 24 * 60 * 60 * 1000;
    const record: FrecencyRecord = {
      agentId: 'a',
      timestamps: [oneHundredDaysAgo],
      totalCount: 1,
    };
    expect(calcFrecencyScore(record, NOW)).toBe(0);
  });

  it('applies totalCount multiplier to bucket sum', () => {
    const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
    const record: FrecencyRecord = { agentId: 'a', timestamps: [twoHoursAgo], totalCount: 5 };
    expect(calcFrecencyScore(record, NOW)).toBe(500);
  });

  it('averages bucket scores across timestamps', () => {
    const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
    const twoDaysAgo = NOW - 2 * 24 * 60 * 60 * 1000;
    const record: FrecencyRecord = {
      agentId: 'a',
      timestamps: [twoHoursAgo, twoDaysAgo],
      totalCount: 2,
    };
    // bucketSum = 100 + 60 = 160, denominator = min(2, 10) = 2
    // score = 2 * 160 / 2 = 160
    expect(calcFrecencyScore(record, NOW)).toBe(160);
  });

  it('caps denominator at MAX_TIMESTAMPS (10)', () => {
    const recent = NOW - 1 * 60 * 60 * 1000;
    const timestamps = Array(10).fill(recent);
    const record: FrecencyRecord = {
      agentId: 'a',
      timestamps,
      totalCount: 50,
    };
    // bucketSum = 10 * 100 = 1000, denominator = min(10, 10) = 10
    // score = 50 * 1000 / 10 = 5000
    expect(calcFrecencyScore(record, NOW)).toBe(5000);
  });
});

describe('useAgentFrecency', () => {
  it('uses new storage key dorkos:agent-frecency-v2', async () => {
    const { useAgentFrecency } = await import('../use-agent-frecency');
    const { result } = renderHook(() => useAgentFrecency());
    act(() => {
      result.current.recordUsage('agent-1');
    });
    expect(store['dorkos:agent-frecency-v2']).toBeDefined();
  });

  it('does not read from old storage key', async () => {
    store['dorkos-agent-frecency'] = JSON.stringify([
      { agentId: 'old', lastUsed: new Date().toISOString(), useCount: 10 },
    ]);
    const { useAgentFrecency } = await import('../use-agent-frecency');
    const { result } = renderHook(() => useAgentFrecency());
    expect(result.current.entries).toHaveLength(0);
  });

  it('caps timestamps at 10 entries', async () => {
    const { useAgentFrecency } = await import('../use-agent-frecency');
    const { result } = renderHook(() => useAgentFrecency());
    for (let i = 0; i < 15; i++) {
      act(() => {
        result.current.recordUsage('agent-1');
      });
    }
    const records = JSON.parse(store['dorkos:agent-frecency-v2']) as FrecencyRecord[];
    expect(records[0].timestamps.length).toBeLessThanOrEqual(10);
    expect(records[0].totalCount).toBe(15);
  });

  it('returns agents sorted by frecency score', async () => {
    const { useAgentFrecency } = await import('../use-agent-frecency');
    const { result } = renderHook(() => useAgentFrecency());
    act(() => {
      result.current.recordUsage('agent-1');
    });
    act(() => {
      result.current.recordUsage('agent-2');
    });
    act(() => {
      result.current.recordUsage('agent-2');
    });
    act(() => {
      result.current.recordUsage('agent-2');
    });
    const sorted = result.current.getSortedAgentIds(['agent-1', 'agent-2', 'agent-3']);
    expect(sorted[0]).toBe('agent-2');
    expect(sorted[1]).toBe('agent-1');
  });
});
