import { Activity } from 'lucide-react';
import { EmptyState } from '@/layers/shared/ui';
import { CATEGORY_CONFIG } from '@/layers/entities/activity';
import type { ActivityCategory } from '@/layers/entities/activity';
import { useActivityFilters } from '../model/use-activity-filters';
import type { ActivityView } from '../model/use-activity-view';

export interface ActivityEmptyStateProps {
  /**
   * When true the feed has events but all are filtered out.
   * When false no events exist at all.
   */
  isFiltered?: boolean;
  /** Which list is empty. `all` is the audit log, which has no category filters. */
  view?: ActivityView;
  className?: string;
}

/**
 * Empty state for the activity feed page.
 *
 * Two variants, one shell — the shared `EmptyState`:
 * - No events ever — "No activity yet".
 * - Filtered, no results — category-specific message + "Clear filters" action.
 *
 * The "All actions" view has its own line, since it lists people's actions too.
 */
export function ActivityEmptyState({
  isFiltered = false,
  view = 'activity',
  className,
}: ActivityEmptyStateProps) {
  const { filters, clearAll } = useActivityFilters();

  if (view === 'all') {
    return (
      <EmptyState
        className={className}
        icon={Activity}
        headline="No actions yet"
        description="Every action a person or agent takes shows up here."
      />
    );
  }

  if (!isFiltered) {
    return (
      <EmptyState
        className={className}
        icon={Activity}
        headline="No activity yet"
        description="Your agents’ work shows up here."
      />
    );
  }

  return (
    <EmptyState
      className={className}
      icon={Activity}
      headline={`No ${buildCategoryLabel(filters.categories)} activity found`}
      description="Try other filters."
      action={{ label: 'Clear filters', onClick: clearAll, variant: 'outline' }}
    />
  );
}

/**
 * Build a human-readable label from a comma-separated category string.
 *
 * "tasks" → "Tasks"
 * "tasks,relay" → "Tasks or Relay"
 * undefined → "matching"
 */
function buildCategoryLabel(categories: string | undefined): string {
  if (!categories) return 'matching';

  const cats = categories.split(',') as ActivityCategory[];
  const labels = cats.map((c) => CATEGORY_CONFIG[c]?.label ?? c);

  if (labels.length === 1) return labels[0];
  const last = labels[labels.length - 1];
  const rest = labels.slice(0, -1);
  return `${rest.join(', ')} or ${last}`;
}
