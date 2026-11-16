/**
 * The one rule for how loose a scheduled task may be approved without a
 * separate yes (DOR-3637). The server's refusal and the approval card's tick
 * both read it, so the card can never offer a one-click approve the server
 * then refuses, nor the reverse.
 *
 * @module schedule-approval
 */

/**
 * How much each Claude Code mode lets an unattended run do, loosest highest.
 * `default` and `dontAsk` share a rank: with nobody there to answer, neither
 * does anything it was not already allowed to.
 */
const MODE_LOOSENESS: Readonly<Record<string, number>> = {
  plan: 0,
  default: 1,
  dontAsk: 1,
  acceptEdits: 2,
  auto: 2,
  bypassPermissions: 3,
};

/** The mode outsider-written work starts at: the tightest one that still runs. */
export const OUTSIDER_SCHEDULE_MODE = 'dontAsk';

/**
 * Whether `next` lets a run do more than `current`. A mode this table cannot
 * name (another runtime's own id) reads as the loosest when it is the new one
 * and the strictest when it is the old one, so anything unknown asks a person.
 *
 * @param next - The mode a change would set.
 * @param current - The mode it is measured against.
 */
export function isLooserScheduleMode(next: string, current: string): boolean {
  if (next === current) return false;
  const rank = (mode: string) =>
    Object.hasOwn(MODE_LOOSENESS, mode) ? MODE_LOOSENESS[mode] : undefined;
  return (rank(next) ?? Infinity) > (rank(current) ?? -Infinity);
}

/** The parts of a schedule the baseline reads. */
export interface ScheduleApprovalBaselineInput {
  /** The saved mode, already clamped by DorkOS. */
  permissionMode: string;
  /** The mode the proposer asked for, if any. */
  requestedPermissionMode?: string | null;
  /** Marks from the turn that wrote it; `outsider` holds it to the floor. */
  originMarks?: { outsider?: boolean } | null;
}

/**
 * The loosest mode a person may approve with one click: the tightest of the
 * saved mode, the requested mode, and, for work written after reading outside
 * words, {@link OUTSIDER_SCHEDULE_MODE}. A request can only narrow it, never
 * widen it, so an agent asking for Full access still needs the separate yes.
 *
 * @param task - The schedule waiting for approval.
 */
export function scheduleApprovalBaseline(task: ScheduleApprovalBaselineInput): string {
  const candidates = [
    task.permissionMode,
    task.requestedPermissionMode ?? undefined,
    task.originMarks?.outsider ? OUTSIDER_SCHEDULE_MODE : undefined,
  ].filter((mode): mode is string => typeof mode === 'string');
  return candidates.reduce((tightest, mode) =>
    isLooserScheduleMode(tightest, mode) ? mode : tightest
  );
}
