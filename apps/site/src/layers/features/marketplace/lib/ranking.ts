/**
 * Marketplace package ranking + filtering.
 *
 * Combines featured weight (from the DorkOS sidecar), log-scaled install
 * counts, and client-supplied filters (type, category, search text) into
 * a sorted list suitable for rendering on the /marketplace browse page.
 *
 * @module features/marketplace/lib/ranking
 */

import { matchesMarketplaceSearch, type MergedMarketplaceEntry } from '@dorkos/marketplace';

const FEATURED_WEIGHT = 100;
const INSTALL_LOG_WEIGHT = 10;

/** Filters supported by the /marketplace page search params. */
export interface RankFilters {
  type?: string;
  category?: string;
  q?: string;
}

/** A ranked entry — the merged entry plus the computed score. */
export type RankedPackage = MergedMarketplaceEntry & { score: number };

/**
 * Filter and rank a merged marketplace package list.
 *
 * Filters are applied first (type, category, search text), then a score
 * is computed for each surviving package and the list is sorted descending
 * by score.
 *
 * @param packages - Merged entries from `fetchMarketplaceJson()`
 * @param installCounts - Map of package name to install count from telemetry
 * @param filters - Optional filters from the page query string
 */
export function rankPackages(
  packages: MergedMarketplaceEntry[],
  installCounts: Record<string, number>,
  filters: RankFilters = {}
): RankedPackage[] {
  let filtered = packages;

  if (filters.type) {
    filtered = filtered.filter((p) => (p.dorkos?.type ?? 'plugin') === filters.type);
  }
  if (filters.category) {
    filtered = filtered.filter((p) => p.category === filters.category);
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    filtered = filtered.filter((p) => matchesMarketplaceSearch(p, q));
  }

  return filtered
    .map((p) => ({
      ...p,
      score: scorePackage(p, installCounts[p.name] ?? 0),
    }))
    .sort((a, b) => b.score - a.score);
}

function scorePackage(pkg: MergedMarketplaceEntry, installCount: number): number {
  const featuredScore = pkg.dorkos?.featured ? FEATURED_WEIGHT : 0;
  const installScore = Math.log(Math.max(1, installCount)) * INSTALL_LOG_WEIGHT;
  return featuredScore + installScore;
}
