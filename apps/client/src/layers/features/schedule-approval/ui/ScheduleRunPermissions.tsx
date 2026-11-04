import { isBypassPermissionMode } from '@/layers/shared/lib';

/** The visible mode and its unattended limits; shared by review and creation surfaces. */
export function ScheduleRunPermissions({
  mode,
  label,
  runtime,
  showLabel = true,
}: {
  mode: string;
  label: string;
  runtime: string | null;
  showLabel?: boolean;
}) {
  return (
    <div data-slot="schedule-permission-mode" className="space-y-1 text-xs">
      {showLabel && <p>Runs as: {label}</p>}
      {isBypassPermissionMode(mode) && <p>Runs without asking.</p>}
      {runtime === 'claude-code' && mode === 'acceptEdits' && (
        <>
          <p>Edits files without asking.</p>
          <p>Some commands run on their own.</p>
          <p>Others are refused, because nobody’s there to approve them.</p>
        </>
      )}
    </div>
  );
}
