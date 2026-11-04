/** Server-authored schedule file faults shared by the parser and its displays. */
export const MISPLACED_SCHEDULE_PERMISSIONS =
  "`permissions` is in the wrong place, so this schedule won't run. Move it under `schedule`.";

/** What a supervised trial of this parked file actually runs as. */
export const MISPLACED_PERMISSIONS_RUN_ONCE = 'Runs as Accept edits, not the value in the file.';

/** A stored parser fault; never a permission grant or a caller identity. */
export function hasMisplacedSchedulePermissions(task: {
  reason?: string | null;
  status?: string;
}): boolean {
  return task.status !== 'active' && task.reason === MISPLACED_SCHEDULE_PERMISSIONS;
}
