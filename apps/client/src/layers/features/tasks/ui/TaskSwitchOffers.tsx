/**
 * The Schedules row's answers that touch a task's switch (DOR-3309).
 *
 * Only a person turns a task on. Approving a parked task keeps its switch as
 * it is, so an off task offers "Approve (stays off)" first and "Approve and
 * turn on" beside it. A task whose file now says on, while the task stayed
 * off, offers Turn on.
 *
 * @module features/tasks/ui/TaskSwitchOffers
 */
import { toast } from 'sonner';
import type { Task } from '@dorkos/shared/types';
import { useDeleteTask, useUpdateTask } from '@/layers/entities/tasks';

const OUTLINE_BUTTON =
  'border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-2.5 py-1 text-xs font-medium shadow-xs transition-colors';
const GHOST_BUTTON =
  'hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors';

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
          toast(task.enabled || turnOn ? 'Schedule approved' : 'Schedule approved, still off'),
      }
    );
  };
  return (
    <div className="flex gap-1">
      <button className={OUTLINE_BUTTON} onClick={(e) => approve(e, false)}>
        {task.enabled ? 'Approve' : 'Approve (stays off)'}
      </button>
      {!task.enabled && (
        <button className={OUTLINE_BUTTON} onClick={(e) => approve(e, true)}>
          Approve and turn on
        </button>
      )}
      <button
        className={GHOST_BUTTON}
        onClick={(e) => {
          e.stopPropagation();
          deleteTask.mutate(task.id);
        }}
      >
        Reject
      </button>
    </div>
  );
}

/**
 * "The file turns this task on", with Turn on, for a task that stayed off when
 * its file started saying on. A parked task is approved in the same act, as
 * the row's switch does: `status` is operator-only, so a person's Turn on is
 * the approval.
 */
export function TaskTurnOnOffer({ task }: { task: Task }) {
  const updateTask = useUpdateTask();
  if (!task.offersTurnOn || task.enabled) return null;
  return (
    <div
      data-slot="task-turn-on-offer"
      className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 text-xs"
    >
      <span className="break-words">The file turns this task on. It stays off until you do.</span>
      <button
        className={OUTLINE_BUTTON}
        onClick={(e) => {
          e.stopPropagation();
          updateTask.mutate({
            id: task.id,
            enabled: true,
            ...(task.status === 'pending_approval' && { status: 'active' as const }),
          });
        }}
      >
        Turn on
      </button>
    </div>
  );
}
