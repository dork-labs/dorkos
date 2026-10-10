import { useMemo } from 'react';
import { PageContainer, PageHeading } from '@/layers/shared/ui';
import { useAuditFeed } from '@/layers/entities/activity';
import {
  useFullActivityFeed,
  useActivityFilters,
  useActivityView,
  useLastVisitedActivity,
  ActivityFilterBar,
  ActivitySinceLastVisit,
  ActivityViewToggle,
} from '@/layers/features/activity-feed-page';
import { ActivityTimeline } from './ui/ActivityTimeline';
import { ActivityLoadMore } from './ui/ActivityLoadMore';
import { ActivityWeekSummary } from './ui/ActivityWeekSummary';
import { ExtensionSections } from './ui/ExtensionSections';

/**
 * Activity page — full-page, time-grouped, paginated activity feed at /activity.
 *
 * Two lists behind one toggle (`?view=all`): the Activity feed, and every
 * action the audit log recorded. Each list is its own component so only the
 * one on screen fetches.
 *
 *   ActivityViewToggle + ActivityFilterBar (filters belong to the feed only)
 *   ActivityWeekSummary     (week-at-a-glance line + sparkline)
 *   ExtensionSections       (conditional "From your extensions" sections)
 *   ActivityFeedList | AllActionsList
 */
export function ActivityPage() {
  const { view, setView } = useActivityView();

  return (
    <>
      <PageHeading>Activity</PageHeading>
      <PageContainer width="wide" className="space-y-4">
        {/* The filters, and the first thing on the page rather than a passenger in
          the header (spec §3.4, phase H1). They belong to what they filter: the
          bar above is the four home surfaces now, and a row of category chips
          wedged into it left no room for the tabs on a phone. The audit log has
          no categories, so its view drops the chips and keeps the toggle. */}
        <div className="flex min-w-0 items-center gap-3">
          <ActivityViewToggle view={view} onViewChange={setView} />
          {view === 'activity' && <ActivityFilterBar className="min-w-0 flex-1" />}
        </div>

        {/* How busy the week has been — zero DOM until the session list answers */}
        <ActivityWeekSummary />

        {/* Extension-contributed sections — zero DOM when no extension contributes */}
        <ExtensionSections />

        {view === 'all' ? <AllActionsList /> : <ActivityFeedList />}
      </PageContainer>
    </>
  );
}

/** The Activity feed: digest banner, time-grouped rows, and paging. */
function ActivityFeedList() {
  const { queryFilters, isFiltered } = useActivityFilters();
  const lastVisitedAt = useLastVisitedActivity();

  const { data, isLoading, isError, refetch, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useFullActivityFeed(queryFilters);

  // Flatten all pages into a single sorted item array
  const allItems = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  return (
    <>
      {/* Digest banner — only visible when there is a prior visit with new events */}
      <ActivitySinceLastVisit lastVisitedAt={lastVisitedAt} items={allItems} />

      {/* Time-grouped event rows */}
      <ActivityTimeline
        items={allItems}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        isFiltered={isFiltered}
      />

      {/* Cursor-based pagination trigger */}
      <ActivityLoadMore
        onLoadMore={() => void fetchNextPage()}
        isFetching={isFetchingNextPage}
        hasNextPage={!!hasNextPage}
      />
    </>
  );
}

/** Every recorded action, newest first, read from the audit log. */
function AllActionsList() {
  const { data, isLoading, isError, refetch, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useAuditFeed();

  return (
    <>
      <ActivityTimeline
        items={data ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        isFiltered={false}
        view="all"
      />
      <ActivityLoadMore
        onLoadMore={() => void fetchNextPage()}
        isFetching={isFetchingNextPage}
        hasNextPage={!!hasNextPage}
      />
    </>
  );
}
