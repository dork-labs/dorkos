import type { Task } from '@dorkos/shared/types';
import {
  scheduleClockTime,
  scheduleFailureTitle,
  scheduleFailureSentence,
  scheduleNextClause,
  scheduleRunHref,
} from '@dorkos/shared/schedule-notice-copy';
import { Button } from '@/layers/shared/ui';
import { useSafeNavigate } from '@/layers/shared/model';

/**
 * The card's reason, as a sentence that stands alone: the fixed cause words,
 * then when it tries again when the schedule is still set to run.
 *
 * @param task - The failing schedule.
 */
function scheduleCardReason(task: Task): string {
  const reason = scheduleFailureSentence(task.health?.reason);
  const next =
    task.enabled && task.status === 'active' && task.nextRun ? new Date(task.nextRun) : null;
  if (!next || Number.isNaN(next.getTime())) return reason;
  return `${reason} ${scheduleNextClause('try', scheduleClockTime(next))}`;
}

/** Needs you derives from run history, so recovery removes the card automatically. */
export function FailingScheduleList({ schedules }: { schedules: readonly Task[] }) {
  const navigate = useSafeNavigate();
  return (
    <>
      {schedules.map((task) => (
        <div
          key={task.id}
          data-testid="schedule-failure"
          className="border-border min-w-0 rounded-md border p-3"
        >
          <p className="truncate text-sm font-medium">{scheduleFailureTitle(task)}</p>
          <p className="text-muted-foreground text-xs">{scheduleCardReason(task)}</p>
          {task.health?.lastRunId && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                if (navigate)
                  void navigate({ href: scheduleRunHref(task.id, task.health!.lastRunId!) });
              }}
            >
              Open run
            </Button>
          )}
        </div>
      ))}
    </>
  );
}
