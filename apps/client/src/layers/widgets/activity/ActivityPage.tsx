import { useMemo } from 'react';
import { ScrollArea } from '@/layers/shared/ui';
import {
  useFullActivityFeed,
  useActivityFilters,
  useLastVisitedActivity,
  ActivitySinceLastVisit,
} from '@/layers/features/activity-feed-page';
import { ActivityTimeline } from './ui/ActivityTimeline';
import { ActivityLoadMore } from './ui/ActivityLoadMore';

/**
 * Activity page — full-page, time-grouped, paginated activity feed at /activity.
 *
 * Composes useFullActivityFeed (infinite-scroll data), useActivityFilters
 * (URL-synced filters), and useLastVisitedActivity (digest banner) into a
 * scrollable layout:
 *
 *   ActivitySinceLastVisit  (conditional digest banner)
 *   ActivityTimeline        (time-grouped rows + skeleton/empty states)
 *   ActivityLoadMore        (load next page button)
 */
export function ActivityPage() {
  const { queryFilters, isFiltered } = useActivityFilters();
  const lastVisitedAt = useLastVisitedActivity();

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useFullActivityFeed(queryFilters);

  // Flatten all pages into a single sorted item array
  const allItems = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-4xl space-y-4 py-6 sm:py-8">
        {/* Digest banner — only visible when there is a prior visit with new events */}
        <ActivitySinceLastVisit lastVisitedAt={lastVisitedAt} items={allItems} className="mx-4" />

        {/* Time-grouped event rows */}
        <ActivityTimeline items={allItems} isLoading={isLoading} isFiltered={isFiltered} />

        {/* Cursor-based pagination trigger */}
        <ActivityLoadMore
          onLoadMore={() => void fetchNextPage()}
          isFetching={isFetchingNextPage}
          hasNextPage={!!hasNextPage}
        />
      </div>
    </ScrollArea>
  );
}
