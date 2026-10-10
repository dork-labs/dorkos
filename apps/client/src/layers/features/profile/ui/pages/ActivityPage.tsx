/**
 * Activity — everything this agent did, had done to it, or had done on its
 * behalf, from the audit log (spec `audit-trail` PR4).
 *
 * The same rows the Activity page draws, laid out compact for the profile's
 * narrow column: the data is the account timeline, the drawing is the Activity
 * feed's own row, so this page cannot drift from that one.
 *
 * @module features/profile/ui/pages/ActivityPage
 */
import { useMemo } from 'react';
import { Activity } from 'lucide-react';
import { Button, EmptyState, Skeleton, Spinner, Table, TableBody } from '@/layers/shared/ui';
import { groupByTime, useAccountTimeline, type TimeGroupLabel } from '@/layers/entities/activity';
import {
  ActivityErrorState,
  ActivityGroupHeader,
  ActivityRow,
} from '@/layers/features/activity-feed-page';
import type { ProfilePageContentProps } from './types';

/**
 * This agent's timeline, newest first, 50 at a time.
 *
 * An identity with no manifest id has no timeline of its own here — the rows
 * only offer this page on an agent — so it says so rather than showing nothing.
 */
export function ActivityPage({ member }: ProfilePageContentProps) {
  const agentId = member.agent?.manifestId ?? null;
  const { data, isLoading, isError, refetch, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useAccountTimeline(agentId);
  const rows = useMemo(() => data ?? [], [data]);
  const groups = useMemo(() => groupByTime(rows, new Date()), [rows]);

  if (agentId === null) {
    return (
      <div className="min-h-0 flex-1 px-4 py-3" data-slot="profile-activity">
        <p className="text-muted-foreground text-xs">Activity is kept per agent.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div
        className="min-h-0 flex-1 space-y-2 px-4 py-3"
        data-slot="profile-activity"
        aria-busy="true"
      >
        <Skeleton className="h-3 w-16" />
        {Array.from({ length: 5 }).map((_, i) => (
          // Static index key is safe: skeleton rows are decorative and never reorder.
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  }

  // A later page failing keeps the rows already on screen (the Activity
  // page's own rule), so the error state only replaces an empty list.
  if (isError && rows.length === 0) {
    return (
      <div className="min-h-0 flex-1 px-2" data-slot="profile-activity">
        <ActivityErrorState onRetry={() => void refetch()} />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="min-h-0 flex-1 px-4 py-8" data-slot="profile-activity">
        <EmptyState
          icon={Activity}
          headline="Nothing on record yet"
          description={`What ${member.displayName} does shows up here.`}
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 px-2 py-2" data-slot="profile-activity">
      {groups.map((group) => (
        <section key={group.label}>
          <ActivityGroupHeader label={group.label as TimeGroupLabel} />
          <Table>
            <TableBody>
              {group.items.map((item) => (
                <ActivityRow key={item.id} item={item} compact />
              ))}
            </TableBody>
          </Table>
        </section>
      ))}
      {hasNextPage && (
        <div className="flex justify-center py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="gap-2"
          >
            {isFetchingNextPage && <Spinner size="xs" />}
            Load 50 more
          </Button>
        </div>
      )}
    </div>
  );
}
