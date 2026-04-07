/**
 * Filter state hook for the activity feed page.
 * Reads from and writes to URL search params via TanStack Router.
 *
 * @module features/activity-feed-page/model/use-activity-filters
 */
import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type {
  ActivityCategory,
  ActorType,
  ListActivityQuery,
} from '@dorkos/shared/activity-schemas';

/** Active filter values read from URL search params. */
export interface ActivityFilters {
  /** Comma-separated category filter, or undefined for "All". */
  categories: string | undefined;
  /** Actor type filter. */
  actorType: ActorType | undefined;
  /** Actor ID filter (narrows to a specific agent). */
  actorId: string | undefined;
  /** ISO 8601 lower-bound timestamp — only show events after this time. */
  since: string | undefined;
}

/** Return type of useActivityFilters. */
export interface UseActivityFiltersReturn {
  /** Current filter values derived from URL. */
  filters: ActivityFilters;
  /** Derived filters object ready to pass directly to useFullActivityFeed. */
  queryFilters: Partial<ListActivityQuery>;
  /** True when any filter has an active (non-default) value. */
  isFiltered: boolean;
  /** Set a single category toggle (adds or removes from the comma-separated list). */
  toggleCategory: (category: ActivityCategory) => void;
  /** Set the actor type filter. Pass undefined to clear. */
  setActorType: (actorType: ActorType | undefined) => void;
  /** Set the actor ID filter. Pass undefined to clear. */
  setActorId: (actorId: string | undefined) => void;
  /** Set the since timestamp filter. Pass undefined to clear. */
  setSince: (since: string | undefined) => void;
  /** Clear all active filters. */
  clearAll: () => void;
}

// Cast required: the hook uses strict: false so TanStack Router cannot infer
// the route-specific search type at compile time.
type AnySearchUpdater = (
  prev: Record<string, string | undefined>
) => Record<string, string | undefined>;

const FILTER_KEYS = ['categories', 'actorType', 'actorId', 'since'] as const;

/**
 * URL-synced filter state for the activity feed page.
 *
 * Reads filter values from TanStack Router search params and provides setters
 * that update the URL. Works with `strict: false` so it can be used from any
 * component within the `/activity` route subtree without hard-coding the route path.
 */
export function useActivityFilters(): UseActivityFiltersReturn {
  const navigate = useNavigate();
  // strict: false — works across any component without a registered search schema
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;

  const filters: ActivityFilters = {
    categories: search.categories,
    actorType: search.actorType as ActorType | undefined,
    actorId: search.actorId,
    since: search.since,
  };

  const isFiltered = FILTER_KEYS.some((key) => search[key] !== undefined);

  // Derived query filters object passed directly to useFullActivityFeed
  const queryFilters: Partial<ListActivityQuery> = {};
  if (filters.categories) queryFilters.categories = filters.categories;
  if (filters.actorType) queryFilters.actorType = filters.actorType;
  if (filters.actorId) queryFilters.actorId = filters.actorId;
  if (filters.since) queryFilters.since = filters.since;

  const updateSearch = useCallback(
    (updater: AnySearchUpdater) => {
      navigate({ search: updater as never });
    },
    [navigate]
  );

  const toggleCategory = useCallback(
    (category: ActivityCategory) => {
      updateSearch((prev) => {
        const current = prev.categories ? prev.categories.split(',') : [];
        const next = current.includes(category)
          ? current.filter((c) => c !== category)
          : [...current, category];
        return {
          ...prev,
          categories: next.length > 0 ? next.join(',') : undefined,
        };
      });
    },
    [updateSearch]
  );

  const setActorType = useCallback(
    (actorType: ActorType | undefined) => {
      updateSearch((prev) => ({ ...prev, actorType }));
    },
    [updateSearch]
  );

  const setActorId = useCallback(
    (actorId: string | undefined) => {
      updateSearch((prev) => ({ ...prev, actorId }));
    },
    [updateSearch]
  );

  const setSince = useCallback(
    (since: string | undefined) => {
      updateSearch((prev) => ({ ...prev, since }));
    },
    [updateSearch]
  );

  const clearAll = useCallback(() => {
    updateSearch((prev) => {
      const next = { ...prev };
      for (const key of FILTER_KEYS) {
        delete next[key];
      }
      return next;
    });
  }, [updateSearch]);

  return {
    filters,
    queryFilters,
    isFiltered,
    toggleCategory,
    setActorType,
    setActorId,
    setSince,
    clearAll,
  };
}
