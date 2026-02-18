import { useMemo } from 'react';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

export interface HealthStats {
  totalItems: number;
  mustHavePercent: number;
  inProgressCount: number;
  atRiskCount: number;
  blockedCount: number;
  completedCount: number;
}

/** Derive health stats from a list of roadmap items. Returns zeroed stats for an empty list. */
export function computeHealthStats(items: RoadmapItem[]): HealthStats {
  const total = items.length;
  if (total === 0) {
    return {
      totalItems: 0,
      mustHavePercent: 0,
      inProgressCount: 0,
      atRiskCount: 0,
      blockedCount: 0,
      completedCount: 0,
    };
  }

  const mustHaveCount = items.filter((i) => i.moscow === 'must-have').length;
  const inProgressCount = items.filter((i) => i.status === 'in-progress').length;
  const atRiskCount = items.filter((i) => i.health === 'at-risk').length;
  const blockedCount = items.filter((i) => i.health === 'blocked').length;
  const completedCount = items.filter((i) => i.status === 'completed').length;

  return {
    totalItems: total,
    mustHavePercent: Math.round((mustHaveCount / total) * 100),
    inProgressCount,
    atRiskCount,
    blockedCount,
    completedCount,
  };
}

/**
 * Compute health stats from a memoized list of roadmap items.
 *
 * @param items - Full list of roadmap items; defaults to empty array.
 */
export function useHealthStats(items: RoadmapItem[] = []): HealthStats {
  return useMemo(() => computeHealthStats(items), [items]);
}
