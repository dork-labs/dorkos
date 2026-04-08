/**
 * Pure sorting utilities for marketplace package arrays.
 *
 * @module features/marketplace/lib/package-sort
 */
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import type { DorkHubSort } from '../model/dork-hub-store';

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

/**
 * Alphabetical comparator by `name`.
 *
 * @param a - Left-hand package.
 * @param b - Right-hand package.
 */
function byName(a: AggregatedPackage, b: AggregatedPackage): number {
  return a.name.localeCompare(b.name);
}

/**
 * Featured-first comparator, falling back to name order.
 *
 * @param a - Left-hand package.
 * @param b - Right-hand package.
 */
function byFeatured(a: AggregatedPackage, b: AggregatedPackage): number {
  const af = a.featured ? 1 : 0;
  const bf = b.featured ? 1 : 0;
  if (af !== bf) return bf - af;
  return byName(a, b);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sort a list of marketplace packages by the chosen sort order.
 *
 * - `featured`: featured packages first, then alphabetical by name.
 * - `name`: alphabetical by name.
 * - `popular`: falls back to alphabetical by name — `installCount` is not
 *   present on `AggregatedPackage` yet and will be wired when that field lands.
 * - `recent`: falls back to alphabetical by name — `updatedAt` is not present
 *   on `AggregatedPackage` yet and will be wired when that field lands.
 *
 * @param packages - Package list to sort (original array is not mutated).
 * @param sort - Active sort order from the Dork Hub store.
 * @returns A new sorted array.
 */
export function sortPackages(
  packages: AggregatedPackage[],
  sort: DorkHubSort
): AggregatedPackage[] {
  const copy = [...packages];

  switch (sort) {
    case 'featured':
      return copy.sort(byFeatured);

    // `popular` and `recent` fall back to name until the backing fields land
    // on AggregatedPackage. The switch exhausts all DorkHubSort values so
    // adding a new sort variant will produce a compile-time error here.
    case 'popular':
    case 'recent':
    case 'name':
      return copy.sort(byName);
  }
}
