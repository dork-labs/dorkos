import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ActivityItem } from '@/layers/entities/activity';

/** Maximum items fetched for the dashboard preview. */
const DASHBOARD_ACTIVITY_LIMIT = 15;

/**
 * Stable query key for the dashboard/Pulse activity preview. Exported so the
 * SSE freshness bridge ({@link usePulseFreshness}) can invalidate the exact same
 * cache this hook reads, instead of duplicating the string literal.
 */
export const DASHBOARD_ACTIVITY_QUERY_KEY = ['dashboard-activity'] as const;

/** A labelled time bucket of activity items. */
export interface DashboardActivityGroup {
  label: string;
  items: ActivityItem[];
}

/** Canonical display order for time buckets. */
const GROUP_ORDER = ['Today', 'Yesterday', 'This Week', 'Earlier'] as const;

/** Group activity items into time buckets relative to now. */
function groupByTime(items: ActivityItem[]): DashboardActivityGroup[] {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());

  const buckets = new Map<string, ActivityItem[]>();

  for (const item of items) {
    const d = new Date(item.occurredAt);
    let label: string;
    if (d >= today) label = 'Today';
    else if (d >= yesterday) label = 'Yesterday';
    else if (d >= weekStart) label = 'This Week';
    else label = 'Earlier';

    const group = buckets.get(label) ?? [];
    group.push(item);
    buckets.set(label, group);
  }

  return GROUP_ORDER.filter((l) => buckets.has(l)).map((l) => ({
    label: l,
    items: buckets.get(l)!,
  }));
}

/**
 * Fetch recent activity from the server API for the dashboard preview.
 * Returns items grouped by time bucket with a flag indicating more exist.
 */
export function useDashboardActivity() {
  const transport = useTransport();

  const { data, isLoading } = useQuery({
    queryKey: DASHBOARD_ACTIVITY_QUERY_KEY,
    queryFn: () => transport.listActivityEvents({ limit: DASHBOARD_ACTIVITY_LIMIT }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const groups = useMemo(() => groupByTime(data?.items ?? []), [data?.items]);

  return {
    groups,
    hasMore: data?.nextCursor != null,
    isLoading,
  };
}
