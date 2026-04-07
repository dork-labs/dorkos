/**
 * Marketplace package ranking + filtering.
 *
 * Combines featured weight (manual curation), log-scaled install counts, and
 * client-supplied filters (type, category, search text) into a sorted list
 * suitable for rendering on the /marketplace browse page.
 *
 * @module features/marketplace/lib/ranking
 */

import type { MarketplaceJsonEntry } from '@dorkos/marketplace';

const FEATURED_WEIGHT = 100;
const INSTALL_LOG_WEIGHT = 10;

/** Filters supported by the /marketplace page search params. */
export interface RankFilters {
  type?: string;
  category?: string;
  q?: string;
}

/** A ranked entry — the original entry plus the computed score. */
export type RankedPackage = MarketplaceJsonEntry & { score: number };

/**
 * Filter and rank a marketplace package list.
 *
 * Filters are applied first (type, category, search text), then a score is
 * computed for each surviving package and the list is sorted descending by
 * score.
 *
 * @param packages - All packages from marketplace.json
 * @param installCounts - Map of package name to install count from telemetry
 * @param filters - Optional filters from the page query string
 */
export function rankPackages(
  packages: MarketplaceJsonEntry[],
  installCounts: Record<string, number>,
  filters: RankFilters = {}
): RankedPackage[] {
  let filtered = packages;

  if (filters.type) {
    filtered = filtered.filter((p) => p.type === filters.type);
  }
  if (filters.category) {
    filtered = filtered.filter((p) => p.category === filters.category);
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    filtered = filtered.filter((p) => matchesSearch(p, q));
  }

  return filtered
    .map((p) => ({
      ...p,
      score: scorePackage(p, installCounts[p.name] ?? 0),
    }))
    .sort((a, b) => b.score - a.score);
}

function matchesSearch(pkg: MarketplaceJsonEntry, q: string): boolean {
  if (pkg.name.toLowerCase().includes(q)) return true;
  if ((pkg.description ?? '').toLowerCase().includes(q)) return true;
  return (pkg.tags ?? []).some((t) => t.toLowerCase().includes(q));
}

function scorePackage(pkg: MarketplaceJsonEntry, installCount: number): number {
  const featuredScore = pkg.featured ? FEATURED_WEIGHT : 0;
  const installScore = Math.log(Math.max(1, installCount)) * INSTALL_LOG_WEIGHT;
  return featuredScore + installScore;
}
