/**
 * What a SKILL.md's `enabled` may do to the task it backs (DOR-3309).
 *
 * **A file may switch a task off, never on.** Only a person turns a task on.
 * A file a sync found is nobody's decision: a `git pull` that brings back
 * `enabled: true`, or a file with no `enabled` line at all (which reads as
 * on), would otherwise switch a task a person turned off back on at the next
 * sweep, with nothing anywhere saying why. So when the file says on and the
 * task is off, the task stays off and the person is offered "Turn on" instead.
 *
 * The offer is made once, when the file STARTS saying on, which is why the row
 * keeps the file's own switch as it was last read (`file_enabled`). Without it a
 * schedule from an installed package that ships on, switched off by a person,
 * would offer itself again at every sweep forever.
 *
 * Off is the safe direction, so a file may always take it. For the agent's own
 * file that is plain: the file's switch is copied. For a package's schedule, or
 * one project's copy of a shared one, the switch lives on the row (FB-26,
 * DOR-3376), so a file that ships off does not undo a person's on; only a file
 * that CHANGES from on to off switches the row off.
 *
 * The same rule holds for every place a file can come from: the agent's own
 * skills, one project's copy of a shared schedule, and a package's.
 *
 * @module services/tasks/sync/file-switch
 */
import type { pulseSchedules } from '@dorkos/db';
import type { FileSyncSource } from '../file-sync-gates.js';

/** What {@link resolveFileSwitch} decided about one sync. */
export interface FileSwitchVerdict {
  /** True when the row's `enabled` must be left off, whatever the file says. */
  holdsOff: boolean;
  /** True when the file has just changed from on to off, so the row goes off too. */
  turnsOff: boolean;
  /** The columns to write: the file's switch, and whether "Turn on" is offered. */
  columns: { fileEnabled: boolean; offersTurnOn: boolean };
}

/**
 * Decide what the file's switch does to the row it lands on.
 *
 * Only a sync DorkOS ran on its own (`discovery`) is held back. An operator
 * write is a person acting through DorkOS, so what it says is their choice.
 * And only a row a person has decided about: one still waiting for its first
 * approval is off because its file said so, not because anybody switched it
 * off, so its file's switch still governs it and approving it is the person's
 * act (a package that starts shipping its schedule on asks for approval,
 * DOR-2059).
 *
 * @param existing - The row the file is landing on, when there is one.
 * @param fileEnabled - The file's `enabled`, its default included.
 * @param options - Where the write came from.
 */
export function resolveFileSwitch(
  existing: typeof pulseSchedules.$inferSelect | undefined,
  fileEnabled: boolean,
  options?: FileSyncSource
): FileSwitchVerdict {
  const holdsOff =
    existing !== undefined &&
    !existing.enabled &&
    fileEnabled &&
    options?.source === 'discovery' &&
    personDecided(existing);
  // Offered when the file has just changed from off to on. A row older than
  // the column knows nothing about its file yet, so it is offered nothing.
  const offersTurnOn =
    holdsOff && (existing?.fileEnabled === false || existing?.offersTurnOn === true);
  const turnsOff =
    existing !== undefined && existing.enabled && !fileEnabled && existing.fileEnabled === true;
  return { holdsOff, turnsOff, columns: { fileEnabled, offersTurnOn } };
}

/**
 * Whether a person has ever said yes to this row: it is live, or it was
 * approved at some point, whatever has happened since.
 */
function personDecided(row: typeof pulseSchedules.$inferSelect): boolean {
  return (
    row.status !== 'pending_approval' ||
    row.approvedContentKey !== null ||
    row.previousApprovalKey !== null
  );
}
