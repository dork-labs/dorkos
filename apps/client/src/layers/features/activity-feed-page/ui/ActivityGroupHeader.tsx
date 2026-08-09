import { cn } from '@/layers/shared/lib';
import type { TimeGroupLabel } from '../model/time-grouping';

export interface ActivityGroupHeaderProps {
  /** One of the canonical time group labels. */
  label: TimeGroupLabel;
  className?: string;
}

/**
 * Sticky section header that divides the activity timeline into time buckets
 * (Today, Yesterday, This Week, Earlier).
 *
 * Visually muted to keep focus on the rows beneath it.
 */
export function ActivityGroupHeader({ label, className }: ActivityGroupHeaderProps) {
  return (
    <div
      data-slot="activity-group-header"
      className={cn(
        'sticky top-0 z-10 -mx-4 px-4 py-2 sm:-mx-6 sm:px-6',
        'bg-background/95 backdrop-blur-sm',
        className
      )}
    >
      <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
        {label}
      </h3>
    </div>
  );
}
