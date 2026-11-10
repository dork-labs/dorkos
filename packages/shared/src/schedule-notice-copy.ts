/**
 * Fixed schedule-notice words. Recorded free text never crosses into a room.
 * @module schedule-notice-copy
 */
import type { Task, TaskFailureReason } from './types.js';

/** Short literal text: schedule names are data, never links or mentions. */
export function scheduleNoticeName(task: Pick<Task, 'name' | 'displayName'>): string {
  const name =
    (task.displayName?.trim() || task.name || 'Schedule')
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/[@[\]<>\x60*_#\\]/g, '')
      .trim() || 'Schedule';
  const words = name.split(/\s+/);
  const short = words.slice(0, 2).join(' ').slice(0, 48);
  return short + (short.length < name.length ? '…' : '');
}

/** A cause from the stored health catalogue, expressed only in fixed words. */
export function scheduleFailureClause(reason: TaskFailureReason | null | undefined): string {
  switch (reason?.kind) {
    case 'signin_needed':
      return 'its sign-in expired';
    case 'tool_refused':
    case 'tools_refused':
      return reason.tools.includes('Bash') ? 'a command was refused' : 'a tool was refused';
    default:
      return 'an unknown error';
  }
}

/** A standing schedule problem disappears as soon as run history becomes healthy. */
export function scheduleNeedsAttention(task: Task): boolean {
  return task.health?.state === 'failing' && task.health.streak >= 2;
}

/** The shared Needs you title, using the run's recorded cause rather than current settings. */
export function scheduleFailureTitle(task: Task, blocked = isScheduleBlocked(task)): string {
  return blocked
    ? `${scheduleNoticeName(task)} was blocked twice in a row`
    : `${scheduleNoticeName(task)} failed twice in a row`;
}

/** Whether the persisted failure is a refusal rather than an execution error. */
export function isScheduleBlocked(task: Task): boolean {
  return (
    task.health?.reason?.kind === 'tool_refused' || task.health?.reason?.kind === 'tools_refused'
  );
}

/** Address one actual run; this contains only app-owned identifiers. */
export function scheduleRunHref(taskId: string, runId: string): string {
  return `/tasks?schedule=${encodeURIComponent(taskId)}&run=${encodeURIComponent(runId)}`;
}
