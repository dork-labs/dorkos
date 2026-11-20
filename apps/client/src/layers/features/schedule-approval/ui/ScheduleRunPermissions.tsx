import { cn, isBypassPermissionMode } from '@/layers/shared/lib';
import { schedulePermissionExplanation } from '../lib/schedule-permission-copy';

/**
 * The visible mode and its unattended limits. Named the way the picker is
 * labelled, "Run permissions", so the words match wherever the mode shows; "Runs
 * as" read like it named an agent (DOR-4572).
 */
export function ScheduleRunPermissions({
  mode,
  label,
  showLabel = true,
}: {
  mode: string;
  label: string;
  showLabel?: boolean;
}) {
  return (
    <div
      data-slot="schedule-permission-mode"
      className={cn('space-y-1 text-xs', isBypassPermissionMode(mode) && 'text-status-warning-fg')}
    >
      {showLabel && <p>Run permissions: {label}</p>}
      <p data-slot="schedule-mode-explanation">{schedulePermissionExplanation(mode)}</p>
    </div>
  );
}
