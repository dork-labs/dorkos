import { useId, useMemo } from 'react';
import { motion } from 'motion/react';
import { Skeleton, Table, TableBody, TableRow, TableCell } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  ActivityRow,
  ActivityGroupHeader,
  ActivityEmptyState,
  groupByTime,
  useActivityKeyboardNav,
} from '@/layers/features/activity-feed-page';
import type { ActivityItem } from '@/layers/entities/activity';

// ---------------------------------------------------------------------------
// Per-group fade animation (replaces per-row stagger since motion.div
// cannot wrap <tr> elements inside <tbody>)
// ---------------------------------------------------------------------------

const groupFade = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
} as const;

// ---------------------------------------------------------------------------
// Skeleton rows
// ---------------------------------------------------------------------------

/**
 * Skeleton shimmer for a single activity row while data is loading.
 *
 * Uses `useId()` to derive a deterministic summary width so each skeleton
 * row looks slightly different without relying on `Math.random()`.
 */
function ActivityRowSkeleton() {
  const id = useId();

  // Derive a deterministic width (50-90%) from the React-generated id so each
  // row appears slightly different. Using `style` here because the width is
  // dynamically computed and cannot be expressed as a Tailwind class.
  const summaryWidth = useMemo(() => {
    const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return `${(hash % 40) + 50}%`;
  }, [id]);

  return (
    <TableRow>
      {/* Time column — matches the w-28 fixed-width time slot in ActivityRow */}
      <TableCell className="w-28 py-1.5 pr-0 pl-2">
        <Skeleton className="h-3 w-20" />
      </TableCell>
      {/* Actor badge — matches the w-24 actor badge slot */}
      <TableCell className="w-24 py-1.5 pr-0">
        <Skeleton className="h-5 w-20 rounded-full" />
      </TableCell>
      {/* Summary — variable width for visual variety */}
      <TableCell className="py-1.5">
        <Skeleton className="h-3 rounded" style={{ width: summaryWidth }} />
      </TableCell>
      {/* Link column placeholder */}
      <TableCell className="w-16 py-1.5" />
    </TableRow>
  );
}

/** Five-row skeleton with a group header, matching the live timeline anatomy. */
function ActivityTimelineSkeleton() {
  return (
    <div data-slot="activity-timeline-skeleton" className="space-y-1">
      {/* Skeleton group header — mirrors ActivityGroupHeader layout */}
      <div className="py-2">
        <Skeleton className="h-3 w-16 rounded" />
      </div>
      {/* Skeleton rows */}
      <Table>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            // Static index key is safe — skeleton rows are purely decorative
            // and never reorder. eslint-disable-next-line react/no-array-index-key
            <ActivityRowSkeleton key={i} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivityTimeline
// ---------------------------------------------------------------------------

export interface ActivityTimelineProps {
  /** All loaded activity items (flattened from all pages). */
  items: ActivityItem[];
  /** When true shows a skeleton loader instead of items. */
  isLoading: boolean;
  /** When true every item is filtered out — shows filtered empty state. */
  isFiltered: boolean;
  className?: string;
}

/**
 * Time-grouped activity timeline.
 *
 * Groups items into Today / Yesterday / This Week / Earlier buckets.
 * Renders a sticky group header above each bucket. Shows a skeleton
 * shimmer while data is loading, or an empty state when no items match.
 */
export function ActivityTimeline({
  items,
  isLoading,
  isFiltered,
  className,
}: ActivityTimelineProps) {
  const groups = useMemo(() => groupByTime(items, new Date()), [items]);
  const { containerRef, handleKeyDown } = useActivityKeyboardNav(items.length);

  if (isLoading && items.length === 0) {
    return (
      <div data-slot="activity-timeline" className={cn('px-4', className)}>
        <ActivityTimelineSkeleton />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div data-slot="activity-timeline" className={cn(className)}>
        <ActivityEmptyState isFiltered={isFiltered} />
      </div>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- roving-tabindex container: arrow keys delegate focus to [data-activity-row] items, not a standard interactive widget
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      data-slot="activity-timeline"
      className={cn('px-4', className)}
    >
      {groups.map((group) => (
        <section key={group.label}>
          <ActivityGroupHeader
            label={group.label as 'Today' | 'Yesterday' | 'This Week' | 'Earlier'}
          />
          <motion.div variants={groupFade} initial="initial" animate="animate">
            <Table>
              <TableBody>
                {group.items.map((item) => (
                  <ActivityRow key={item.id} item={item} />
                ))}
              </TableBody>
            </Table>
          </motion.div>
        </section>
      ))}
    </div>
  );
}
