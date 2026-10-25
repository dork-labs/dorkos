/**
 * The warning a schedule's create and edit forms show when its stop would ask
 * for something on a scheduled run, where nobody is there to answer
 * (DOR-3123 A1, DOR-3132).
 *
 * QA's census on 2026-10-25 found 23 refusals in one day, every one on a
 * schedule at Accept edits: the stop a person picks to mean "get on with it",
 * which still asks before it runs a command. On a scheduled run that ask is
 * refused at once, so the form says so before the schedule is saved, and
 * points at Never ask with an allow list — never at Full autonomy, which no
 * surface offers as a fix (spec `schedules-failing` SF-18). Saving with it
 * showing is allowed; it is the person's call.
 *
 * @module features/tasks/ui/TaskUnattendedWarning
 */
import { TriangleAlert } from 'lucide-react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { NEVER_ASK_MODE_ID } from '../lib/schedule-health';

/**
 * Whether a schedule at this mode would raise an ask on a scheduled run —
 * which, with nobody there, is refused.
 *
 * @param mode - The runtime's descriptor for the schedule's mode.
 */
export function asksWhileUnattended(mode: PermissionModeDescriptor): boolean {
  return mode.asks !== 'never' && mode.id !== NEVER_ASK_MODE_ID;
}

/** The warning itself. Render it only when {@link asksWhileUnattended} holds. */
export function TaskUnattendedWarning() {
  return (
    <div
      role="note"
      data-testid="task-unattended-warning"
      className="bg-status-warning-bg border-status-warning-border text-status-warning-fg flex gap-2 rounded-md border px-2.5 py-2 text-xs leading-relaxed"
    >
      <TriangleAlert className="mt-0.5 size-5 shrink-0 sm:size-3.5" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">Nobody is there to approve asks on a scheduled run.</p>
        <p>Each ask is refused, so the run will need attention.</p>
        <p>Use Never ask with an allow list for the commands it needs.</p>
        <p>“Run now” still asks you.</p>
      </div>
    </div>
  );
}
