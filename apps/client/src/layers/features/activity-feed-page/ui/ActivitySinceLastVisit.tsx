import { motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { CATEGORY_CONFIG } from '@/layers/entities/activity';
import type { ActivityItem, ActivityCategory } from '@/layers/entities/activity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a relative time string for the "last visit" label.
 *
 * @param iso - ISO 8601 timestamp of the previous visit.
 */
function formatTimeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'recently';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Count items per category for those occurring after `since`.
 *
 * @param items - Flat list of activity items (all pages).
 * @param since - ISO 8601 lower-bound timestamp.
 */
function countByCategory(
  items: ActivityItem[],
  since: string
): Partial<Record<ActivityCategory, number>> {
  const sinceDate = new Date(since);
  const counts: Partial<Record<ActivityCategory, number>> = {};

  for (const item of items) {
    if (new Date(item.occurredAt) > sinceDate) {
      counts[item.category] = (counts[item.category] ?? 0) + 1;
    }
  }

  return counts;
}

/**
 * Build the digest line: "3 Tasks runs · 1 Relay event · 2 Agent updates"
 */
function buildDigestLine(counts: Partial<Record<ActivityCategory, number>>): string {
  const CATEGORY_SUFFIXES: Record<ActivityCategory, string> = {
    tasks: 'Scheduled run',
    relay: 'Relay event',
    agent: 'Agent update',
    config: 'Config change',
    system: 'System event',
  };

  return (Object.entries(counts) as [ActivityCategory, number][])
    .filter(([, count]) => count > 0)
    .map(([cat, count]) => {
      const label = CATEGORY_SUFFIXES[cat];
      return `${count} ${count === 1 ? label : `${label}s`}`;
    })
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ActivitySinceLastVisitProps {
  /**
   * ISO 8601 timestamp of the previous activity feed visit.
   * Pass null when there is no prior visit or the banner should not show.
   */
  lastVisitedAt: string | null;
  /** Flat list of activity items from all loaded pages. */
  items: ActivityItem[];
  className?: string;
}

/**
 * Digest banner summarising new activity since the user's last visit.
 *
 * Animates in with a fade + slide-down on mount. Only renders when there is
 * a recorded previous visit and at least one new event since then.
 */
export function ActivitySinceLastVisit({
  lastVisitedAt,
  items,
  className,
}: ActivitySinceLastVisitProps) {
  if (!lastVisitedAt) return null;

  const counts = countByCategory(items, lastVisitedAt);
  const totalNew = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  if (totalNew === 0) return null;

  const timeAgo = formatTimeAgo(lastVisitedAt);
  const digest = buildDigestLine(counts);

  return (
    <motion.div
      data-slot="activity-since-last-visit"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={cn('rounded-lg border px-4 py-3', 'bg-card border-border', className)}
    >
      <p className="text-muted-foreground text-xs">
        <span className="text-foreground font-medium">Since your last visit</span>{' '}
        <span>({timeAgo})</span>
      </p>
      <p className="text-foreground/80 mt-0.5 text-sm">{digest}</p>
      {/* Category color indicators */}
      <div className="mt-2 flex flex-wrap gap-2">
        {(Object.keys(counts) as ActivityCategory[]).map((cat) => {
          const count = counts[cat];
          if (!count) return null;
          const config = CATEGORY_CONFIG[cat];
          return (
            <span
              key={cat}
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                config.bg,
                config.text
              )}
            >
              {count} {config.label}
            </span>
          );
        })}
      </div>
    </motion.div>
  );
}
