/**
 * URL-synced browse state for the `/marketplace` route.
 *
 * Reads the type filter, sort order, free-text search, category, and open
 * package from the URL search params and provides setters that write back to
 * the URL. Making the URL the source of truth (matching `/agents`, `/session`,
 * and the activity feed) means every browse selection survives refresh and is
 * shareable as a link. Transient install-flow state stays in
 * `useMarketplaceStore`.
 *
 * @module features/marketplace/model/use-marketplace-params
 */
import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { MarketplaceSort, MarketplaceTypeFilter, MarketplaceView } from './marketplace-search';
import { normalizeCategoryParam } from './marketplace-search';

/** Browse state derived from the URL plus setters that write back to it. */
export interface MarketplaceParams {
  /** Active top-level view (`'browse'` catalog vs `'installed'` manage list). */
  view: MarketplaceView;
  /** Active package-type filter (`'all'` = no type restriction). */
  type: MarketplaceTypeFilter;
  /** Active sort order. */
  sort: MarketplaceSort;
  /** Committed free-text search string (`''` when absent). */
  search: string;
  /**
   * Selected category slugs, OR-combined by the filter (empty array = no
   * category restriction). The URL keeps the legacy single-value form for a
   * lone selection (`?category=security`) and only switches to the array form
   * for multiple, so single-category links stay clean and back-compatible.
   */
  categories: string[];
  /** Name of the package open in the detail drawer, or `null` when closed. */
  selectedPackageName: string | null;
  /** Switch the top-level view (browse vs installed). */
  setView: (view: MarketplaceView) => void;
  /** Set the package-type filter. */
  setType: (type: MarketplaceTypeFilter) => void;
  /** Set the sort order. */
  setSort: (sort: MarketplaceSort) => void;
  /** Set the free-text search string. */
  setSearch: (search: string) => void;
  /** Add the slug if absent, remove it if present (multi-select OR facet). */
  toggleCategory: (slug: string) => void;
  /** Replace the whole category selection. */
  setCategories: (slugs: string[]) => void;
  /** Clear every selected category. */
  clearCategories: () => void;
  /** Reset type, sort, search, and category to their defaults (keeps the drawer). */
  resetFilters: () => void;
  /** Open the detail drawer for a package (pushes history so Back closes it). */
  openDetail: (name: string) => void;
  /** Close the detail drawer. */
  closeDetail: () => void;
}

/**
 * Serialize the selected category slugs back into the URL: dropped when empty,
 * a bare string for a single selection (clean + back-compatible with legacy
 * `?category=slug` links), and the array form only once more than one is picked.
 */
function serializeCategories(slugs: string[]): string | string[] | undefined {
  if (slugs.length === 0) return undefined;
  if (slugs.length === 1) return slugs[0];
  return slugs;
}

/**
 * Normalize marketplace-owned search keys so default values are omitted from
 * the URL (undefined → dropped), while any unrelated keys (e.g. dialog params)
 * pass through untouched.
 */
function normalize(next: Record<string, unknown>): Record<string, unknown> {
  const q = typeof next.q === 'string' && next.q.trim().length > 0 ? next.q : undefined;
  return {
    ...next,
    view: next.view === 'browse' ? undefined : next.view,
    type: next.type === 'all' ? undefined : next.type,
    sort: next.sort === 'featured' ? undefined : next.sort,
    q,
    category: serializeCategories(normalizeCategoryParam(next.category)),
    pkg: next.pkg ?? undefined,
  };
}

/**
 * Hook exposing the marketplace browse state from the URL and setters to update
 * it. Usable from any component within the `/marketplace` route subtree.
 */
export function useMarketplaceParams(): MarketplaceParams {
  const navigate = useNavigate();
  // strict: false — the hook works from any route that renders the marketplace
  // subtree (the real /marketplace page, the dev playground, and tests) without
  // hard-coding a route id. The typed schema still validates/defaults the URL on
  // the /marketplace route; here we read loosely and re-apply the same defaults.
  // navigate() is called without `to`, so it patches the current route's search.
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const view = (search.view === 'installed' ? 'installed' : 'browse') as MarketplaceView;
  const type = (typeof search.type === 'string' ? search.type : 'all') as MarketplaceTypeFilter;
  const sort = (typeof search.sort === 'string' ? search.sort : 'featured') as MarketplaceSort;
  const q = typeof search.q === 'string' ? search.q : undefined;
  const categories = normalizeCategoryParam(search.category);
  const pkg = typeof search.pkg === 'string' ? search.pkg : undefined;

  const patch = useCallback(
    (changes: Record<string, unknown>, options?: { replace?: boolean }) => {
      void navigate({
        search: (prev) => normalize({ ...(prev as Record<string, unknown>), ...changes }) as never,
        replace: options?.replace,
      });
    },
    [navigate]
  );

  // View switches push history (not replace) so Back returns to the prior view,
  // matching how the detail drawer treats a navigation as a discrete step.
  const setView = useCallback((next: MarketplaceView) => patch({ view: next }), [patch]);
  const setType = useCallback(
    (next: MarketplaceTypeFilter) => patch({ type: next }, { replace: true }),
    [patch]
  );
  const setSort = useCallback(
    (next: MarketplaceSort) => patch({ sort: next }, { replace: true }),
    [patch]
  );
  const setSearch = useCallback((next: string) => patch({ q: next }, { replace: true }), [patch]);
  const toggleCategory = useCallback(
    (slug: string) => {
      const next = categories.includes(slug)
        ? categories.filter((c) => c !== slug)
        : [...categories, slug];
      patch({ category: next }, { replace: true });
    },
    [patch, categories]
  );
  const setCategories = useCallback(
    (slugs: string[]) => patch({ category: slugs }, { replace: true }),
    [patch]
  );
  const clearCategories = useCallback(() => patch({ category: [] }, { replace: true }), [patch]);
  const resetFilters = useCallback(
    () =>
      patch(
        { type: undefined, sort: undefined, q: undefined, category: undefined },
        { replace: true }
      ),
    [patch]
  );
  const openDetail = useCallback((name: string) => patch({ pkg: name }), [patch]);
  const closeDetail = useCallback(() => patch({ pkg: undefined }, { replace: true }), [patch]);

  return {
    view,
    type,
    sort,
    search: q ?? '',
    categories,
    selectedPackageName: pkg ?? null,
    setView,
    setType,
    setSort,
    setSearch,
    toggleCategory,
    setCategories,
    clearCategories,
    resetFilters,
    openDetail,
    closeDetail,
  };
}
