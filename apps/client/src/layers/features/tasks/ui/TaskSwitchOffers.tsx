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
import { toast } from 'sonner';
import type { Task } from '@dorkos/shared/types';
import { useDeleteTask, useUpdateTask } from '@/layers/entities/tasks';
import { Button } from '@/layers/shared/ui';

/** The card's button size (`ScheduleApprovalCard`), so the two read alike. */
const BUTTON_CLASS = 'h-7 px-2.5 text-xs';

/**
 * Approve or reject a parked task from its row.
 *
 * Approve sends `status` alone, so the switch stays as stored; only "Approve
 * and turn on" sends `enabled: true` with it.
 */
export function TaskApproveButtons({ task }: { task: Task }) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  // No local onError: the shared mutation toasts (`meta.errorLabel`) report a
  // failure. Bare, matching Run started on the row.
  const approve = (e: React.MouseEvent, turnOn: boolean) => {
    e.stopPropagation();
    updateTask.mutate(
      { id: task.id, status: 'active', ...(turnOn && { enabled: true }) },
      {
        onSuccess: () =>
          toast(
            task.enabled || turnOn
              ? 'Schedule approved'
              : 'Schedule approved. Off until you turn it on.'
          ),
      }
    );
  };
  return (
    <div className="flex flex-wrap gap-1">
      <Button size="sm" className={BUTTON_CLASS} onClick={(e) => approve(e, false)}>
        Approve
      </Button>
      {!task.enabled && (
        <Button
          variant="outline"
          size="sm"
          className={BUTTON_CLASS}
          onClick={(e) => approve(e, true)}
        >
          Approve and turn on
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className={BUTTON_CLASS}
        onClick={(e) => {
          e.stopPropagation();
          deleteTask.mutate(task.id);
        }}
      >
        Reject
      </Button>
    </div>
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
