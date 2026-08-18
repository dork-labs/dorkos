/**
 * Pure filtering utilities for marketplace package arrays.
 *
 * @module features/marketplace/lib/package-filter
 */
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { CONNECTOR_ADAPTER_TYPE, matchesMarketplaceSearch } from '@dorkos/marketplace';
import type { MarketplaceTypeFilter } from '../model/marketplace-search';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Criteria applied to {@link filterPackages}. */
export interface FilterCriteria {
  /** Package type filter — `'all'` returns every type. */
  type: MarketplaceTypeFilter;
  /**
   * Selected category slugs, OR-combined: a package matches when it belongs to
   * ANY selected category. Empty array = no category restriction.
   */
  categories: string[];
  /**
   * Selected marketplace source names, OR-combined: a package matches when it
   * came from ANY selected source. Empty array = no source restriction.
   */
  sources: string[];
  /** Free-text search string (empty string disables search filtering). */
  search: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` when the package matches the active type filter.
 *
 * Packages whose `type` field is absent are treated as `'plugin'` (the
 * default declared in the AggregatedPackage JSDoc). The `'connector'` filter
 * is a refinement of `'adapter'`: it matches only adapter packages whose
 * `adapterType` is the well-known connector value, while the plain
 * `'adapter'` filter still includes them.
 *
 * @param pkg - Package to check.
 * @param typeFilter - Active type filter from the Marketplace store.
 */
function matchesType(pkg: AggregatedPackage, typeFilter: MarketplaceTypeFilter): boolean {
  if (typeFilter === 'all') return true;
  const effectiveType = pkg.type ?? 'plugin';
  if (typeFilter === CONNECTOR_ADAPTER_TYPE) {
    return effectiveType === 'adapter' && pkg.adapterType === CONNECTOR_ADAPTER_TYPE;
  }
  return effectiveType === typeFilter;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Filter a list of marketplace packages by type, category, source, and search text.
 *
 * - Type filter: packages with no `type` field are treated as `'plugin'`.
 * - Category filter: OR across the selected slugs — a package matches when it
 *   belongs to ANY of them. Membership is checked against the multi-membership
 *   `categories[]` list, falling back to the singular `category` for packages
 *   that predate the sidecar. An empty selection imposes no restriction.
 * - Source filter: OR across the selected marketplace source names — the
 *   `marketplace` field every aggregated package carries. An empty selection
 *   imposes no restriction.
 * - Search: case-insensitive substring match across `name`, `description`,
 *   `keywords`, and `tags`. Empty search string matches everything.
 *
 * @param packages - Full package list to filter.
 * @param criteria - Active filter criteria from the Marketplace store.
 * @returns A new array containing only the packages that satisfy all criteria.
 */
export function filterPackages(
  packages: AggregatedPackage[],
  criteria: FilterCriteria
): AggregatedPackage[] {
  const needle = criteria.search.trim().toLowerCase();

  return packages.filter((pkg) => {
    if (!matchesType(pkg, criteria.type)) return false;
    if (criteria.categories.length > 0) {
      // OR: keep the package if it belongs to any selected category. The
      // always-check-singular fallback differs from site ranking.ts's `??`
      // short-circuit only for coherence-violating data (a `category` outside
      // `categories[]`), which the schema refine + server flatten make unreachable.
      const matchesAny = criteria.categories.some(
        (slug) => (pkg.categories?.includes(slug) ?? false) || pkg.category === slug
      );
      if (!matchesAny) return false;
    }
    if (criteria.sources.length > 0 && !criteria.sources.includes(pkg.marketplace)) return false;
    if (needle && !matchesMarketplaceSearch(pkg, needle)) return false;
    return true;
  });
}
