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
import type { MarketplaceSort, MarketplaceTypeFilter } from './marketplace-search';

/** Browse state derived from the URL plus setters that write back to it. */
export interface MarketplaceParams {
  /** Active package-type filter (`'all'` = no type restriction). */
  type: MarketplaceTypeFilter;
  /** Active sort order. */
  sort: MarketplaceSort;
  /** Committed free-text search string (`''` when absent). */
  search: string;
  /** Active category slug filter, or `null` for no restriction. */
  category: string | null;
  /** Name of the package open in the detail drawer, or `null` when closed. */
  selectedPackageName: string | null;
  /** Set the package-type filter. */
  setType: (type: MarketplaceTypeFilter) => void;
  /** Set the sort order. */
  setSort: (sort: MarketplaceSort) => void;
  /** Set the free-text search string. */
  setSearch: (search: string) => void;
  /** Set the category filter. Pass `null` to clear. */
  setCategory: (category: string | null) => void;
  /** Reset type, sort, search, and category to their defaults (keeps the drawer). */
  resetFilters: () => void;
  /** Open the detail drawer for a package (pushes history so Back closes it). */
  openDetail: (name: string) => void;
  /** Close the detail drawer. */
  closeDetail: () => void;
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
    type: next.type === 'all' ? undefined : next.type,
    sort: next.sort === 'featured' ? undefined : next.sort,
    q,
    category: next.category ?? undefined,
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
  const type = (typeof search.type === 'string' ? search.type : 'all') as MarketplaceTypeFilter;
  const sort = (typeof search.sort === 'string' ? search.sort : 'featured') as MarketplaceSort;
  const q = typeof search.q === 'string' ? search.q : undefined;
  const category = typeof search.category === 'string' ? search.category : undefined;
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

  const setType = useCallback(
    (next: MarketplaceTypeFilter) => patch({ type: next }, { replace: true }),
    [patch]
  );
  const setSort = useCallback(
    (next: MarketplaceSort) => patch({ sort: next }, { replace: true }),
    [patch]
  );
  const setSearch = useCallback((next: string) => patch({ q: next }, { replace: true }), [patch]);
  const setCategory = useCallback(
    (next: string | null) => patch({ category: next ?? undefined }, { replace: true }),
    [patch]
  );
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
    type,
    sort,
    search: q ?? '',
    category: category ?? null,
    selectedPackageName: pkg ?? null,
    setType,
    setSort,
    setSearch,
    setCategory,
    resetFilters,
    openDetail,
    closeDetail,
  };
}
