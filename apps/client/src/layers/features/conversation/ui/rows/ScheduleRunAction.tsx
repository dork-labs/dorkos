import { scheduleRunHref } from '@dorkos/shared/schedule-notice-copy';
import { Button } from '@/layers/shared/ui';
import { useSafeNavigate } from '@/layers/shared/model';

/** A schedule system line's one action, naming only the recorded run. */
export function ScheduleRunAction({ report }: { report: { scheduleId: string; runId: string } }) {
  const navigate = useSafeNavigate();
  return (
    <Button
      variant="outline"
      size="sm"
      className="ml-2"
      onClick={() => {
        if (navigate) void navigate({ href: scheduleRunHref(report.scheduleId, report.runId) });
      }}
    >
      Open run
    </Button>
  );
}
