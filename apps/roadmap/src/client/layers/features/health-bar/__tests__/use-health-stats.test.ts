/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { computeHealthStats, useHealthStats } from '../model/use-health-stats';
import { createMockRoadmapItem } from '@dorkos/test-utils';

describe('computeHealthStats', () => {
  it('returns zeroed stats for an empty list', () => {
    const stats = computeHealthStats([]);
    expect(stats).toEqual({
      totalItems: 0,
      mustHavePercent: 0,
      inProgressCount: 0,
      atRiskCount: 0,
      blockedCount: 0,
      completedCount: 0,
    });
  });

  it('computes correct stats for a mixed item list', () => {
    const items = [
      createMockRoadmapItem({ moscow: 'must-have', status: 'in-progress', health: 'on-track' }),
      createMockRoadmapItem({ moscow: 'must-have', status: 'completed', health: 'on-track' }),
      createMockRoadmapItem({ moscow: 'should-have', status: 'not-started', health: 'at-risk' }),
      createMockRoadmapItem({ moscow: 'could-have', status: 'on-hold', health: 'blocked' }),
    ];

    const stats = computeHealthStats(items);

    expect(stats.totalItems).toBe(4);
    expect(stats.mustHavePercent).toBe(50);
    expect(stats.inProgressCount).toBe(1);
    expect(stats.atRiskCount).toBe(1);
    expect(stats.blockedCount).toBe(1);
    expect(stats.completedCount).toBe(1);
  });

  it('rounds mustHavePercent to nearest integer', () => {
    const items = [
      createMockRoadmapItem({ moscow: 'must-have' }),
      createMockRoadmapItem({ moscow: 'should-have' }),
      createMockRoadmapItem({ moscow: 'could-have' }),
    ];

    const stats = computeHealthStats(items);
    // 1/3 = 33.33... -> 33
    expect(stats.mustHavePercent).toBe(33);
  });

  it('returns 100% when all items are must-have', () => {
    const items = [
      createMockRoadmapItem({ moscow: 'must-have' }),
      createMockRoadmapItem({ moscow: 'must-have' }),
    ];

    const stats = computeHealthStats(items);
    expect(stats.mustHavePercent).toBe(100);
  });
});

describe('useHealthStats', () => {
  it('returns computed stats from a hook', () => {
    const items = [
      createMockRoadmapItem({ status: 'completed', health: 'on-track' }),
    ];

    const { result } = renderHook(() => useHealthStats(items));

    expect(result.current.totalItems).toBe(1);
    expect(result.current.completedCount).toBe(1);
  });

  it('defaults to empty stats when no items provided', () => {
    const { result } = renderHook(() => useHealthStats());

    expect(result.current.totalItems).toBe(0);
  });
});
