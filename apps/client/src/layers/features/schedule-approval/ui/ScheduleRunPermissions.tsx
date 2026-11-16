import { cn, isBypassPermissionMode } from '@/layers/shared/lib';
import { schedulePermissionExplanation } from '../lib/schedule-permission-copy';

/** The visible mode and its unattended limits; shared by review and creation surfaces. */
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
      {showLabel && <p>Runs as: {label}</p>}
      <p data-slot="schedule-mode-explanation">{schedulePermissionExplanation(mode)}</p>
    </div>
  );
}
