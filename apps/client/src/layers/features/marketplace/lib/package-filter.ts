/**
 * Pure filtering utilities for marketplace package arrays.
 *
 * @module features/marketplace/lib/package-filter
 */
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import type { DorkHubTypeFilter } from '../model/dork-hub-store';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Criteria applied to {@link filterPackages}. */
export interface FilterCriteria {
  /** Package type filter — `'all'` returns every type. */
  type: DorkHubTypeFilter;
  /** Category slug filter, or `null` for no category restriction. */
  category: string | null;
  /** Free-text search string (empty string disables search filtering). */
  search: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the searchable text haystack for a single package.
 *
 * @param pkg - Package to build the haystack from.
 * @returns Lower-cased concatenation of all searchable fields.
 */
function buildHaystack(pkg: AggregatedPackage): string {
  return [pkg.name, pkg.description ?? '', ...(pkg.keywords ?? []), ...(pkg.tags ?? [])]
    .join(' ')
    .toLowerCase();
}

/**
 * Return `true` when the package matches the active type filter.
 *
 * Packages whose `type` field is absent are treated as `'plugin'` (the
 * default declared in the AggregatedPackage JSDoc).
 *
 * @param pkg - Package to check.
 * @param typeFilter - Active type filter from the Dork Hub store.
 */
function matchesType(pkg: AggregatedPackage, typeFilter: DorkHubTypeFilter): boolean {
  if (typeFilter === 'all') return true;
  const effectiveType = pkg.type ?? 'plugin';
  return effectiveType === typeFilter;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Filter a list of marketplace packages by type, category, and search text.
 *
 * - Type filter: packages with no `type` field are treated as `'plugin'`.
 * - Category filter: exact match against `pkg.category`.
 * - Search: case-insensitive substring match across `name`, `description`,
 *   `keywords`, and `tags`. Empty search string matches everything.
 *
 * @param packages - Full package list to filter.
 * @param criteria - Active filter criteria from the Dork Hub store.
 * @returns A new array containing only the packages that satisfy all criteria.
 */
export function filterPackages(
  packages: AggregatedPackage[],
  criteria: FilterCriteria
): AggregatedPackage[] {
  const needle = criteria.search.trim().toLowerCase();

  return packages.filter((pkg) => {
    if (!matchesType(pkg, criteria.type)) return false;
    if (criteria.category !== null && pkg.category !== criteria.category) return false;
    if (needle && !buildHaystack(pkg).includes(needle)) return false;
    return true;
  });
}
