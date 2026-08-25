import { Activity } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
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
 * Two variants:
 * - No events ever — icon + "No activity yet" message.
 * - Filtered, no results — category-specific message + "Clear filters" action.
 */
export function ActivityEmptyState({ isFiltered = false, className }: ActivityEmptyStateProps) {
  const { filters, clearAll } = useActivityFilters();

  if (isFiltered) {
    return (
      <FilteredEmptyState
        categories={filters.categories}
        onClear={clearAll}
        className={className}
      />
    );
  }

  return <NoEventsEmptyState className={className} />;
}

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

function NoEventsEmptyState({ className }: { className?: string }) {
  return (
    <div
      data-slot="activity-empty-state"
      className={cn('flex flex-col items-center justify-center gap-3 py-16 text-center', className)}
    >
      <div className="bg-muted rounded-full p-4">
        <Activity className="text-muted-foreground size-6" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">No activity yet</p>
        <p className="text-muted-foreground max-w-xs text-sm">
          Events will appear here as your agents work.
        </p>
      </div>
    </div>
  );
}

interface FilteredEmptyStateProps {
  categories: string | undefined;
  onClear: () => void;
  className?: string;
}

function FilteredEmptyState({ categories, onClear, className }: FilteredEmptyStateProps) {
  const label = buildCategoryLabel(categories);

  return (
    <div
      data-slot="activity-empty-state"
      className={cn('flex flex-col items-center justify-center gap-3 py-16 text-center', className)}
    >
      <div className="bg-muted rounded-full p-4">
        <Activity className="text-muted-foreground size-6" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">No {label} activity found</p>
        <p className="text-muted-foreground text-sm">Try adjusting your filters.</p>
      </div>
      <Button variant="outline" size="sm" onClick={onClear}>
        Clear filters
      </Button>
    </div>
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
