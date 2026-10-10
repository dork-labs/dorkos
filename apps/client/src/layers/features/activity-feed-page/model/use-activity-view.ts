/**
 * Which list the Activity page shows: the Activity feed, or every recorded
 * action. Kept in the URL (`?view=all`) so the view survives a reload and a
 * link to it opens the same list.
 *
 * @module features/activity-feed-page/model/use-activity-view
 */
import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

/** The two lists the Activity page can show. */
export type ActivityView = 'activity' | 'all';

/** Return type of {@link useActivityView}. */
export interface UseActivityViewReturn {
  /** The list on screen. `activity` unless the URL says `?view=all`. */
  view: ActivityView;
  /** Switch lists. The default view clears the param rather than spelling it. */
  setView: (view: ActivityView) => void;
}

/**
 * URL-synced view state for the Activity page.
 *
 * Reads with `strict: false`, like {@link useActivityFilters}, so any component
 * under `/activity` can ask without naming the route.
 */
export function useActivityView(): UseActivityViewReturn {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const view: ActivityView = search.view === 'all' ? 'all' : 'activity';

  const setView = useCallback(
    (next: ActivityView) => {
      navigate({
        search: ((prev: Record<string, string | undefined>) => ({
          ...prev,
          view: next === 'all' ? 'all' : undefined,
        })) as never,
      });
    },
    [navigate]
  );

  return { view, setView };
}
