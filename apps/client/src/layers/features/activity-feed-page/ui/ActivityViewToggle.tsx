import { SegmentedControl, SegmentedControlItem } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { ActivityView } from '../model/use-activity-view';

export interface ActivityViewToggleProps {
  /** The list on screen. */
  view: ActivityView;
  /** Called with the list the person picked. */
  onViewChange: (view: ActivityView) => void;
  className?: string;
}

/**
 * Switches the Activity page between its feed and every recorded action.
 *
 * Controlled, so the page owns the state (`useActivityView`) and the Dev
 * Playground can show both stops without a router.
 */
export function ActivityViewToggle({ view, onViewChange, className }: ActivityViewToggleProps) {
  return (
    <SegmentedControl
      aria-label="Which list to show"
      className={cn('w-fit shrink-0', className)}
      value={view}
      onValueChange={(next) => onViewChange(next as ActivityView)}
    >
      <SegmentedControlItem value="activity">Activity</SegmentedControlItem>
      <SegmentedControlItem value="all">All actions</SegmentedControlItem>
    </SegmentedControl>
  );
}
