/**
 * Shared marketplace search utilities.
 *
 * Provides a single search function used by both the site's ranking module
 * and the core client's package filter. Accepts a minimal interface so it
 * works with both `MergedMarketplaceEntry` and `AggregatedPackage`.
 *
 * Browser-safe — no dependencies.
 *
 * @module @dorkos/marketplace/search
 */

/**
 * Minimal searchable fields accepted by {@link matchesMarketplaceSearch}.
 * Both `MergedMarketplaceEntry` and `AggregatedPackage` satisfy this shape.
 */
export interface SearchablePackage {
  name: string;
  description?: string;
  keywords?: string[];
  tags?: string[];
}

/**
 * Return `true` when the package matches a case-insensitive search query.
 *
 * Searches across `name`, `description`, `keywords`, and `tags`. The query
 * should already be trimmed and lower-cased by the caller.
 *
 * @param pkg - Package to test.
 * @param query - Lower-cased, trimmed search string.
 */
export function matchesMarketplaceSearch(pkg: SearchablePackage, query: string): boolean {
  if (pkg.name.toLowerCase().includes(query)) return true;
  if ((pkg.description ?? '').toLowerCase().includes(query)) return true;
  if ((pkg.keywords ?? []).some((k) => k.toLowerCase().includes(query))) return true;
  return (pkg.tags ?? []).some((t) => t.toLowerCase().includes(query));
}
