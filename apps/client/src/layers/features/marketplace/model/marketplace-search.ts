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
import type { MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';

/**
 * Type filter for the Marketplace browse grid.
 *
 * `'all'` disables type filtering; the rest correspond directly to
 * `MarketplacePackageType` values so the filter stays in sync with the schema.
 */
export type MarketplaceTypeFilter = 'all' | MarketplacePackageType;

/** Sort order for the Marketplace browse grid. */
export type MarketplaceSort = 'featured' | 'popular' | 'recent' | 'name';

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
 */
export const marketplaceSearchSchema = z.object({
  view: z.enum(['browse', 'installed']).optional(),
  type: z.enum(['all', 'agent', 'plugin', 'skill-pack', 'adapter']).optional(),
  sort: z.enum(['featured', 'popular', 'recent', 'name']).optional(),
  q: z.string().optional(),
  category: z.string().optional(),
  pkg: z.string().optional(),
});
