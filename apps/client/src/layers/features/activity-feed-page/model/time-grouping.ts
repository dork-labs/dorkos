/**
 * Time-based grouping utility for activity feed items.
 *
 * Groups a flat list of ActivityItems into buckets: Today, Yesterday,
 * This Week, and Earlier. Preserves insertion order so the natural
 * descending sort (newest first) flows through intact.
 *
 * @module features/activity-feed-page/model/time-grouping
 */
import type { ActivityItem } from '@dorkos/shared/activity-schemas';

/** A labelled group of activity items. */
export interface ActivityGroup {
  /** Human-readable label: "Today" | "Yesterday" | "This week" | "Earlier". */
  label: string;
  /** Items in this group, in their original insertion order. */
  items: ActivityItem[];
}

/** All possible time group labels in display order (newest → oldest). */
export type TimeGroupLabel = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

const GROUP_ORDER: TimeGroupLabel[] = ['Today', 'Yesterday', 'This week', 'Earlier'];

/**
 * Group activity items by relative time bucket.
 *
 * Items must be sorted newest-first (descending `occurredAt`) before calling
 * this function — the output group order matches `GROUP_ORDER`.
 *
 * @param items - Activity items to group.
 * @param now - Reference date/time (pass `new Date()` in production, a fixed date in tests).
 * @returns Array of groups in Today → Earlier order, omitting empty groups.
 */
export function groupByTime(items: ActivityItem[], now: Date): ActivityGroup[] {
  const buckets = new Map<TimeGroupLabel, ActivityItem[]>();

  for (const item of items) {
    const label = getTimeGroupLabel(new Date(item.occurredAt), now);
    const group = buckets.get(label) ?? [];
    group.push(item);
    buckets.set(label, group);
  }

  // Return groups in canonical display order, omitting empty buckets
  return GROUP_ORDER.filter((label) => buckets.has(label)).map((label) => ({
    label,
    items: buckets.get(label)!,
  }));
}

/**
 * Determine which time group label applies to a given date.
 *
 * Boundaries are computed relative to midnight of `now` so that
 * "Today" always means "same calendar day as now".
 *
 * @param date - The date to classify.
 * @param now - Reference date/time.
 */
export function getTimeGroupLabel(date: Date, now: Date): TimeGroupLabel {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  // Start of the current week (Sunday = 0)
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  if (date >= startOfToday) return 'Today';
  if (date >= startOfYesterday) return 'Yesterday';
  if (date >= startOfWeek) return 'This week';
  return 'Earlier';
}
