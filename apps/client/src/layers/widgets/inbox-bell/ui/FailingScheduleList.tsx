import type { Task } from '@dorkos/shared/types';
import {
  scheduleFailureTitle,
  scheduleFailureClause,
  scheduleRunHref,
} from '@dorkos/shared/schedule-notice-copy';
import { Button } from '@/layers/shared/ui';
import { useSafeNavigate } from '@/layers/shared/model';

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
          <p className="text-muted-foreground text-xs">
            {scheduleFailureClause(task.health?.reason)}
          </p>
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
