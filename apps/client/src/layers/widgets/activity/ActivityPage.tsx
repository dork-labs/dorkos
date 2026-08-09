import { useMemo } from 'react';
import { PageContainer } from '@/layers/shared/ui';
import {
  useFullActivityFeed,
  useActivityFilters,
  useLastVisitedActivity,
  ActivitySinceLastVisit,
} from '@/layers/features/activity-feed-page';
import { ActivityTimeline } from './ui/ActivityTimeline';
import { ActivityLoadMore } from './ui/ActivityLoadMore';
import { ActivityWeekSummary } from './ui/ActivityWeekSummary';
import { ExtensionSections } from './ui/ExtensionSections';

/**
 * Activity page — full-page, time-grouped, paginated activity feed at /activity.
 *
 * Composes useFullActivityFeed (infinite-scroll data), useActivityFilters
 * (URL-synced filters), and useLastVisitedActivity (digest banner) into a
 * scrollable layout:
 *
 *   ActivityWeekSummary     (week-at-a-glance line + sparkline)
 *   ExtensionSections       (conditional "From your extensions" sections)
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
    <PageContainer width="wide" className="space-y-4">
      {/* How busy the week has been — zero DOM until the session list answers */}
      <ActivityWeekSummary />

      {/* Extension-contributed sections — zero DOM when no extension contributes */}
      <ExtensionSections />

      {/* Digest banner — only visible when there is a prior visit with new events */}
      <ActivitySinceLastVisit lastVisitedAt={lastVisitedAt} items={allItems} />

      {/* Time-grouped event rows */}
      <ActivityTimeline items={allItems} isLoading={isLoading} isFiltered={isFiltered} />

      {/* Cursor-based pagination trigger */}
      <ActivityLoadMore
        onLoadMore={() => void fetchNextPage()}
        isFetching={isFetchingNextPage}
        hasNextPage={!!hasNextPage}
      />
    </PageContainer>
  );
}
