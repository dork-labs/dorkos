/**
 * The Schedules row's parts that touch a task's switch (DOR-3309).
 *
 * Only a person turns a task on. Approving a parked task keeps its switch as
 * it is, so an off task offers "Approve" and, beside it, "Approve and turn on".
 * A task whose file now says on, while the task stayed off, says so; the row's
 * own switch is how a person turns it on.
 *
 * @module features/tasks/ui/TaskSwitchOffers
 */
import type { Task } from '@dorkos/shared/types';
import { Button } from '@/layers/shared/ui';

/** The card's button size (`ScheduleApprovalCard`), so the two read alike. */
const BUTTON_CLASS = 'min-h-11 px-2.5 text-xs sm:h-7 sm:min-h-0';

/** Open the shared review before a parked schedule can be approved. */
export function TaskApproveButtons({
  task,
  onReview,
}: {
  task: Task;
  onReview: (element: HTMLElement) => void;
}) {
  return (
    <Button
      size="sm"
      className={BUTTON_CLASS}
      aria-label={`Review ${task.displayName ?? task.name}`}
      onClick={(event) => {
        event.stopPropagation();
        onReview(event.currentTarget);
      }}
    >
      Review
    </Button>
  );
}

/**
 * The note on a task that stayed off when its file started saying on. No
 * button of its own: the row's switch turns it on, and switching it either
 * way clears the note on the server.
 */
export function TaskFileSaysOnNote({ task }: { task: Task }) {
  if (!task.offersTurnOn || task.enabled) return null;
  return (
    <div
      data-slot="task-file-says-on"
      className="text-muted-foreground min-w-0 text-xs break-words"
    >
      Its file says on. It stays off until you switch it on.
    </div>
  );
}
