import { motion } from 'motion/react';
import { CalendarClock } from 'lucide-react';
import cronstrue from 'cronstrue';
import type { Task } from '@dorkos/shared/types';
import { Button } from '@/layers/shared/ui';
import { useUpdateTask, useDeleteTask } from '@/layers/entities/tasks';

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
} as const;

/**
 * When a proposed schedule would run, in words.
 *
 * Falls back to the raw expression rather than to nothing: a cron string
 * somebody can read is better than a row that will not say when it fires.
 *
 * @param cron - The cron expression, or null for an on-demand task.
 */
function whenItRuns(cron: string | null): string {
  if (!cron) return 'On demand';
  try {
    return cronstrue.toString(cron);
  } catch {
    return cron;
  }
}

/** What {@link ScheduleApprovalRow} draws and decides. */
export interface ScheduleApprovalRowProps {
  /** The parked schedule. */
  task: Task;
  /** Called after Approve or Reject is pressed, e.g. to close a popover. */
  onDecided?: () => void;
}

/**
 * One schedule an agent proposed, with the two answers on the row.
 *
 * An agent that creates a schedule never arms it — it parks at
 * `pending_approval` so nothing unattended runs on a person's machine without
 * them saying so (DOR-504). This row is where they say so, wherever they happen
 * to be: on the home surface's triage header and inside the header pill's
 * panel, the same two buttons doing the same two things.
 *
 * **Approve and Reject are the Tasks page's own two mutations** — approving
 * sets the schedule active and enabled, rejecting deletes it. Nothing is
 * duplicated here, so a schedule decided in one place is decided in all of
 * them, and the list refreshes itself off the server's `tasks_changed` event.
 *
 * Neither button toasts on success: the row disappearing IS the confirmation,
 * and the app's one failure toast (`query-client.ts`) already speaks for both
 * mutations when they fail.
 *
 * @param props - The {@link ScheduleApprovalRowProps.task} and an optional
 * {@link ScheduleApprovalRowProps.onDecided} callback.
 */
export function ScheduleApprovalRow({ task, onDecided }: ScheduleApprovalRowProps) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const busy = updateTask.isPending || deleteTask.isPending;
  const name = task.displayName ?? task.name;

  return (
    <motion.div
      variants={staggerItem}
      data-slot="schedule-approval-row"
      className="hover:bg-accent/50 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1 transition-colors"
    >
      <span className="bg-status-warning size-1.5 shrink-0 rounded-full" aria-hidden />
      <CalendarClock className="text-status-warning/70 size-3.5 shrink-0" aria-hidden />
      <span className="text-foreground/90 min-w-0 flex-1 truncate text-xs">
        {name} <span className="text-muted-foreground">· {whenItRuns(task.cron)}</span>
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        className="h-6 shrink-0 px-2 text-xs"
        aria-label={`Approve ${name}`}
        onClick={() => {
          updateTask.mutate({ id: task.id, status: 'active', enabled: true });
          onDecided?.();
        }}
      >
        Approve
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        className="h-6 shrink-0 px-2 text-xs"
        aria-label={`Reject ${name}`}
        onClick={() => {
          deleteTask.mutate(task.id);
          onDecided?.();
        }}
      >
        Reject
      </Button>
    </motion.div>
  );
}
