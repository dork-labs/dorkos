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
 * Only sorts backed by real data ship: `featured` (the `featured` flag) and
 * `name` (alphabetical). `popular` and `recent` return once `AggregatedPackage`
 * carries `installCount`/`updatedAt` — until then an honest menu offers neither.
 */
export type MarketplaceSort = 'featured' | 'name';

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
 * search, `category` is a reserved slug filter (no UI yet), and `pkg` holds the
 * open package's unique `name` for the detail drawer.
 *
 * The closed-enum facets (`type`, `sort`) use `.catch(undefined)` so a stale
 * shared link — an old bookmark whose value this release changed, e.g.
 * `?sort=popular` after Popular/Recent were retired — degrades to the default
 * instead of throwing a route validation error.
 */
export const marketplaceSearchSchema = z.object({
  view: z.enum(['browse', 'installed']).optional(),
  // Derive the type facet from the package taxonomy so a future 6th type can't
  // go stale here the way `shape` once did — `'all'` plus every PackageType.
  type: z
    .enum(['all', ...PackageTypeSchema.options])
    .optional()
    .catch(undefined),
  sort: z.enum(['featured', 'name']).optional().catch(undefined),
  q: z.string().optional(),
  category: z.string().optional(),
  pkg: z.string().optional(),
});
