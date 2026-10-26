/**
 * The parts a failing schedule's row adds (DOR-3123, spec `schedules-failing`
 * §2.4): a status mark in the dot's slot, the reason line, the streak tail on
 * the timing line, and one action.
 *
 * Failing is the only coloured state on the row. A healthy schedule shows
 * nothing in the slot, and the slot keeps its width so the column aligns.
 *
 * @module features/tasks/ui/TaskHealthParts
 */
import { Lock, XCircle } from 'lucide-react';
import type { Task } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { Button, stopLabel } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import {
  describeFailure,
  failingSince,
  isRefusal,
  NEVER_ASK_MODE_ID,
} from '../lib/schedule-health';

/**
 * The Trust Dial's name for the stop a schedule runs at, read from the
 * runtime it runs on, or `null` while that is not known. Never ask is named
 * for itself: it sits inside the Ask first stop, and "runs at Ask first"
 * would point the person at the wrong fix.
 *
 * @param task - The schedule.
 * @param agent - Its agent, whose runtime it follows when it names none.
 */
function useStopName(task: Task, agent: AgentManifest | null | undefined): string | null {
  const capabilities = useCapabilitiesForRuntime(task.runtime ?? agent?.runtime ?? null);
  const descriptor = capabilities?.permissionModes?.values?.find(
    (mode) => mode.id === task.permissionMode
  );
  if (!descriptor) return null;
  return descriptor.id === NEVER_ASK_MODE_ID ? descriptor.label : stopLabel(descriptor.stop);
}

/**
 * The failing status mark: a padlock when a tool was refused, a cross when the
 * run did not finish. 20px on a phone, 16px from `sm` up.
 */
export function TaskFailingMark({ task }: { task: Task }) {
  const refused = isRefusal(task.health?.reason);
  const label = refused ? 'Needs attention' : 'Didn’t finish';
  const Icon = refused ? Lock : XCircle;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-slot="task-failing-mark"
      className="inline-flex shrink-0"
    >
      <Icon className="text-destructive size-5 sm:size-4" aria-hidden />
    </span>
  );
}

/** "· Failing since Tue · 3 runs", for the end of the timing line. */
export function TaskFailingSince({ task }: { task: Task }) {
  const now = useNow();
  if (!task.health || task.health.state !== 'failing') return null;
  return <span data-slot="task-failing-since"> &middot; {failingSince(task.health, now)}</span>;
}

interface TaskFailingReasonProps {
  task: Task;
  agent?: AgentManifest | null;
}

/**
 * The one line that says why the schedule is failing. One line on a desktop,
 * at most two on a phone. A schedule switched off is still failing — switching
 * it off is not fixing it — and the line says it is off.
 */
export function TaskFailingReason({ task, agent }: TaskFailingReasonProps) {
  const stop = useStopName(task, agent);
  const reason = task.health?.reason;
  if (!reason) return null;
  const off = !task.enabled || task.status === 'paused';
  const line = `${describeFailure(reason, stop)}${off ? ' · Off' : ''}`;
  return (
    <div
      data-slot="task-failing-reason"
      title={line}
      className="text-destructive line-clamp-2 min-w-0 text-xs break-words sm:line-clamp-1"
    >
      {line}
    </div>
  );
}

/**
 * The row's one action for a failing schedule. Until a schedule can allow one
 * exact command (DOR-3039), the fix lives in the schedule's own settings, so
 * the action opens them — it never offers to raise the stop.
 */
export function TaskOpenScheduleButton({
  task,
  onOpen,
  className,
}: {
  task: Task;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-slot="task-open-schedule"
      aria-label={`Open schedule ${task.displayName ?? task.name}`}
      className={cn('shrink-0', className)}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      Open schedule
    </Button>
  );
}
