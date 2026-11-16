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
 * The card's status line: what happened, then when it tries again when the
 * schedule is still set to run ("Failed twice in a row · Next try 3:00 PM").
 *
 * @param task - The failing schedule.
 */
function scheduleCardStatus(task: Task): string {
  const verb = scheduleFailureVerb(isScheduleBlocked(task));
  const status = `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
  const next =
    task.enabled && task.status === 'active' && task.nextRun ? new Date(task.nextRun) : null;
  if (!next || Number.isNaN(next.getTime())) return status;
  return `${status} · ${scheduleNextTry(next, new Date()).replace(/\.$/, '')}`;
}

/**
 * Needs you derives from run history, so recovery removes the card automatically.
 *
 * The card is only ever seen by the person, so its title is the schedule's
 * whole name, clamped to two lines with the full name on hover. What happened
 * sits on its own muted line under it, so the card reads the same whatever the
 * name's length. Rooms keep the short name (DOR-4121).
 */
export function FailingScheduleList({ schedules }: { schedules: readonly Task[] }) {
  const navigate = useSafeNavigate();
  return (
    <>
      {schedules.map((task) => {
        const name = scheduleFullName(task);
        return (
          <div
            key={task.id}
            data-testid="schedule-failure"
            className="border-border min-w-0 rounded-md border p-3"
          >
            <p
              data-testid="schedule-failure-title"
              className="line-clamp-2 text-sm font-medium break-words"
              title={name}
            >
              {name}
            </p>
            <p data-testid="schedule-failure-status" className="text-muted-foreground text-xs">
              {scheduleCardStatus(task)}
            </p>
            <p className="text-muted-foreground text-xs">
              {scheduleFailureSentence(task.health?.reason)}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              // Unique per card: several cards would otherwise read alike.
              aria-label={`Open schedule ${name}`}
              onClick={() => {
                if (navigate) void navigate({ href: scheduleExpandHref(task.id) });
              }}
            >
              Open schedule
            </Button>
          </div>
        );
      })}
    </>
  );
}
