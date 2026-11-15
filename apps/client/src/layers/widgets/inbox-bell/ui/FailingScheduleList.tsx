import type { Task } from '@dorkos/shared/types';
import {
  isScheduleBlocked,
  scheduleExpandHref,
  scheduleFailureSentence,
  scheduleFailureVerb,
  scheduleFullName,
  scheduleNextTry,
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
  return `${reason} ${scheduleNextTry(next, new Date())}`;
}

/**
 * Needs you derives from run history, so recovery removes the card automatically.
 *
 * The card is only ever seen by the person, so it carries the schedule's whole
 * name: two lines at most on a wide screen, wrapped in full on a phone. Rooms
 * keep the short name (DOR-4121).
 */
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
          <p
            data-testid="schedule-failure-title"
            className="text-sm break-words sm:line-clamp-2"
            title={scheduleFullName(task)}
          >
            <span className="font-medium">{scheduleFullName(task)}</span>{' '}
            {scheduleFailureVerb(isScheduleBlocked(task))}
          </p>
          <p className="text-muted-foreground text-xs">{scheduleCardReason(task)}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              if (navigate) void navigate({ href: scheduleExpandHref(task.id) });
            }}
          >
            Open schedule
          </Button>
        </div>
      ))}
    </>
  );
}
