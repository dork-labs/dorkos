import { scheduleRunHref } from '@dorkos/shared/schedule-notice-copy';
import { useSafeNavigate } from '@/layers/shared/model';

/**
 * A schedule system line's one action, naming only the recorded run.
 *
 * Words at the line's own size, not a filled button: it sits after the
 * sentence like the session link does. The vertical padding is the hit area
 * (24px with a mouse, 44px on touch). A button lays out as an inline block, so
 * an equal negative margin stops that padding from pushing the line down.
 */
export function ScheduleRunAction({ report }: { report: { scheduleId: string; runId: string } }) {
  const navigate = useSafeNavigate();
  return (
    <button
      type="button"
      data-testid="schedule-run-action"
      className="focus-ring hover:text-foreground -my-1 ml-1.5 rounded py-1 font-medium whitespace-nowrap underline underline-offset-3 pointer-coarse:-my-3.5 pointer-coarse:py-3.5"
      onClick={() => {
        if (navigate) void navigate({ href: scheduleRunHref(report.scheduleId, report.runId) });
      }}
    >
      Open run
    </button>
  );
}
