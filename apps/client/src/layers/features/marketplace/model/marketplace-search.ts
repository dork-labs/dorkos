/**
 * Marketplace browse-state URL schema and filter types.
 *
 * The marketplace persists its browse state (type filter, sort order, free-text
 * search, category, and the open package drawer) in the URL so it survives
 * refresh and can be shared as a link. This module owns the Zod schema wired
 * into the `/marketplace` route (`validateSearch`) and the filter/sort unions
 * consumed by the pure filter/sort helpers and the browse UI.
 *
 * @module features/marketplace/model/marketplace-search
 */
import { z } from 'zod';
import { PackageTypeSchema } from '@dorkos/marketplace';
import type { MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';

/**
 * Type filter for the Marketplace browse grid.
 *
 * `'all'` disables type filtering; the rest correspond directly to
 * `MarketplacePackageType` values so the filter stays in sync with the schema.
 */
export type MarketplaceTypeFilter = 'all' | MarketplacePackageType;

/**
 * Sort order for the Marketplace browse grid.
 *
 * Every sort is backed by real data: `featured` (the `featured` flag), `name`
 * (alphabetical), and `popular` (community install counts from
 * `AggregatedPackage.installCount`). `popular` only appears in the menu when
 * counts are available — offline (no reachable dorkos.ai) it grays out, and a
 * stale `?sort=popular` link falls back to name order. (`recent` returns once
 * `AggregatedPackage` carries `updatedAt`.)
 */
export type MarketplaceSort = 'featured' | 'name' | 'popular';

/**
 * Top-level Marketplace view. `'browse'` is the catalog (search, featured rail,
 * grid); `'installed'` is the Manage Installed surface listing every
 * installation across scopes. Persisted in the URL so the view survives refresh
 * and is shareable.
 */
export type MarketplaceView = 'browse' | 'installed';

/**
 * URL search schema for the `/marketplace` route.
 *
 * All keys are optional with no schema-level defaults, so a bare `/marketplace`
 * URL stays clean (TanStack would otherwise serialize `.default()` values into
 * the address bar). `useMarketplaceParams` applies the `'all'` / `'featured'`
 * defaults on read and omits them on write. `q` is the debounced free-text
 * search, `category` is the multi-select category facet, and `pkg` holds the
 * open package's unique `name` for the detail drawer.
 *
 * The closed-enum facets (`type`, `sort`) use `.catch(undefined)` so a stale
 * shared link — an old bookmark whose value this release changed, e.g.
 * `?sort=recent` after Recent was retired — degrades to the default instead of
 * throwing a route validation error. `category` accepts BOTH the
 * legacy single-value form (`?category=security`, from links shared before the
 * facet panel went multi-select) and the array form the sidebar now writes; its
 * own `.catch(undefined)` drops any garbage rather than erroring the route.
 */
export const marketplaceSearchSchema = z.object({
  view: z.enum(['browse', 'installed']).optional(),
  // Derive the type facet from the package taxonomy so a future 6th type can't
  // go stale here the way `shape` once did — `'all'` plus every PackageType.
  type: z
    .enum(['all', ...PackageTypeSchema.options])
    .optional()
    .catch(undefined),
  sort: z.enum(['featured', 'name', 'popular']).optional().catch(undefined),
  q: z.string().optional(),
  category: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .catch(undefined),
  pkg: z.string().optional(),
});

/**
 * Normalize the raw `category` search value into a de-duplicated slug array.
 *
 * Accepts the legacy single-string form and the multi-select array form,
 * dropping empty and non-string entries so a stale or hand-edited link degrades
 * to a clean array instead of leaking junk into the filter. The order of the
 * incoming values is preserved (first occurrence wins on a duplicate).
 *
 * @param raw - The `category` value straight off the URL search object.
 * @returns The selected category slugs (empty array = no category filter).
 */
export function normalizeCategoryParam(raw: unknown): string[] {
  if (typeof raw === 'string') return raw.length > 0 ? [raw] : [];
  if (Array.isArray(raw)) {
    const seen = new Set<string>();
    for (const value of raw) {
      if (typeof value === 'string' && value.length > 0) seen.add(value);
    }
    return [...seen];
  }
  return [];
}
