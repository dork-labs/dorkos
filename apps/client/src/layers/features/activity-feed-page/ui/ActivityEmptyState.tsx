import { Activity } from 'lucide-react';
import { EmptyState } from '@/layers/shared/ui';
import { CATEGORY_CONFIG } from '@/layers/entities/activity';
import type { ActivityCategory } from '@/layers/entities/activity';
import { useActivityFilters } from '../model/use-activity-filters';

export interface ActivityEmptyStateProps {
  /**
   * When true the feed has events but all are filtered out.
   * When false no events exist at all.
   */
  isFiltered?: boolean;
  className?: string;
}

/**
 * Empty state for the activity feed page.
 *
 * Two variants, one shell — the shared `EmptyState`:
 * - No events ever — "No activity yet".
 * - Filtered, no results — category-specific message + "Clear filters" action.
 */
export function ActivityEmptyState({ isFiltered = false, className }: ActivityEmptyStateProps) {
  const { filters, clearAll } = useActivityFilters();

  if (!isFiltered) {
    return (
      <EmptyState
        className={className}
        icon={Activity}
        headline="No activity yet"
        description="Events will appear here as your agents work."
      />
    );
  }

  return (
    <EmptyState
      className={className}
      icon={Activity}
      headline={`No ${buildCategoryLabel(filters.categories)} activity found`}
      description="Try adjusting your filters."
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
