/**
 * Pure sorting utilities for marketplace package arrays.
 *
 * @module features/marketplace/lib/package-sort
 */
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { packageDisplayLabel } from '@/layers/shared/lib';
import type { MarketplaceSort } from '../model/marketplace-search';

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

/**
 * Alphabetical comparator by the package's *rendered* label, so "A–Z" matches
 * what the cards actually show. Sorting on the raw `name` would read wrong the
 * moment a `displayName` (or a humanized slug) diverges from the slug — see
 * {@link packageDisplayLabel}, the single label both the cards and this sort use.
 *
 * @param a - Left-hand package.
 * @param b - Right-hand package.
 */
function byName(a: AggregatedPackage, b: AggregatedPackage): number {
  return packageDisplayLabel(a).localeCompare(packageDisplayLabel(b));
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

/**
 * Most-installed-first comparator, backed by the community `installCount`
 * enriched server-side. A missing count sorts as `0`, so packages with no
 * recorded installs (and the whole list when counts are unavailable) fall back
 * to name order — the same graceful degrade the Popular menu option relies on.
 *
 * @param a - Left-hand package.
 * @param b - Right-hand package.
 */
function byPopular(a: AggregatedPackage, b: AggregatedPackage): number {
  const ac = a.installCount ?? 0;
  const bc = b.installCount ?? 0;
  if (ac !== bc) return bc - ac;
  return byName(a, b);
}

/**
 * Most-recently-updated-first comparator, backed by the registry-derived
 * `updatedAt` enriched server-side. A missing date sorts as oldest, so packages
 * with no registry-recorded update — an external-source package, or the whole
 * list when dates are unavailable — fall to the end and then to name order, the
 * same graceful degrade the Recent menu option relies on.
 *
 * Dates are ISO 8601 strings, which sort lexicographically in chronological
 * order, so a plain string compare is correct without parsing to `Date`.
 *
 * @param a - Left-hand package.
 * @param b - Right-hand package.
 */
function byRecent(a: AggregatedPackage, b: AggregatedPackage): number {
  const ad = a.updatedAt ?? '';
  const bd = b.updatedAt ?? '';
  if (ad !== bd) return bd.localeCompare(ad);
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
 * - `popular`: most community installs first (`installCount`), tie-broken by
 *   name. Degrades to name order when counts are unavailable (offline), so a
 *   stale `?sort=popular` link stays well-behaved even though the menu hides
 *   the option in that case.
 * - `recent`: most recently updated first (`updatedAt`, the registry-derived
 *   last-commit date), tie-broken by name. Degrades to name order when dates are
 *   unavailable (offline), same as `popular`.
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
    case 'popular':
      return copy.sort(byPopular);
    case 'recent':
      return copy.sort(byRecent);
  }
}
