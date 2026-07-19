/**
 * Pure sorting utilities for marketplace package arrays.
 *
 * @module features/marketplace/lib/package-sort
 */
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import type { MarketplaceSort } from '../model/marketplace-search';

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
 *
 * `popular` and `recent` sorts were removed because the data behind them —
 * `installCount` and `updatedAt` — isn't on `AggregatedPackage` yet, so both
 * silently fell back to name order. Add them back here and in the sort menu
 * once those fields land (tracked in Linear).
 *
 * @param packages - Package list to sort (original array is not mutated).
 * @param sort - Active sort order from the Marketplace store.
 * @returns A new sorted array.
 */
export function sortPackages(
  packages: AggregatedPackage[],
  sort: MarketplaceSort
): AggregatedPackage[] {
  const copy = [...packages];

  // The switch exhausts all MarketplaceSort values, so adding a new sort
  // variant produces a compile-time error here.
  switch (sort) {
    case 'featured':
      return copy.sort(byFeatured);
    case 'name':
      return copy.sort(byName);
  }
}
