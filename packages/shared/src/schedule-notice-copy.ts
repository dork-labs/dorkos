/**
 * Fixed schedule-notice words. Recorded free text never crosses into a room.
 * @module schedule-notice-copy
 */
import type { Task, TaskFailureReason } from './types.js';

/**
 * The whole name as literal text, for surfaces only the person sees (the
 * Needs you card): markup and control characters stripped, nothing cut. The
 * card truncates it with CSS, and wraps it on a phone (DOR-4121).
 */
export function scheduleFullName(task: Pick<Task, 'name' | 'displayName'>): string {
  return (
    (task.displayName?.trim() || task.name || 'Schedule')
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/[@[\]<>\x60*_#\\]/g, '')
      .trim() || 'Schedule'
  );
}

/** Short literal text for room lines: schedule names are data, never links or mentions. */
export function scheduleNoticeName(task: Pick<Task, 'name' | 'displayName'>): string {
  const name = scheduleFullName(task);
  const words = name.split(/\s+/);
  const short = words.slice(0, 2).join(' ').slice(0, 48);
  return short + (short.length < name.length ? '…' : '');
}

/**
 * The run lines DorkOS itself writes, read back into fixed words (DOR-4121).
 * Each pattern matches a sentence a DorkOS writer owns, so the notice can say
 * the real cause without ever repeating recorded text: `relay-dispatch.ts`
 * (a run that never started), `run-time-limit.ts` (the clock), the task
 * store (a restart). A runtime's usage-limit line is the one outside text
 * matched, and only to choose words. Order matters: the hourly turn limit is
 * checked before the usage limit. A line that matches none still says the run
 * didn't finish, which is true of every recorded error.
 */
const ERROR_CAUSES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^(Run stopped after passing its|This run went past its time limit|Run timed out)/,
    'it ran out of time',
  ],
  [/^Every agent slot stayed busy/, 'every agent slot was busy'],
  [/^DorkOS was too busy/, 'DorkOS was too busy'],
  [/^The hourly limit on agent turns/, 'the hourly turn limit was reached'],
  [
    /^(Nothing was available to run|The program this task runs on isn’t running|This run couldn’t start)/,
    'it never started',
  ],
  [/^Interrupted by server restart/, 'DorkOS restarted during the run'],
  [/\b(usage|weekly|daily|monthly|session|5-hour) limit\b|hit your limit/i, 'it hit a usage limit'],
];

/**
 * A cause from the stored health catalogue, expressed only in fixed words.
 * "An unknown error" means exactly that: nothing was recorded.
 */
export function scheduleFailureClause(reason: TaskFailureReason | null | undefined): string {
  switch (reason?.kind) {
    case 'signin_needed':
      return 'its sign-in expired';
    case 'tool_refused':
    case 'tools_refused':
      return reason.tools.includes('Bash') ? 'a command was refused' : 'a tool was refused';
    case 'error': {
      const message = reason.message;
      if (!message) return 'an unknown error';
      return ERROR_CAUSES.find(([pattern]) => pattern.test(message))?.[1] ?? 'it didn’t finish';
    }
    default:
      return 'an unknown error';
  }
}

/**
 * The cause as a sentence that stands alone, for the Needs you card: the same
 * fixed words as {@link scheduleFailureClause}, capitalised and closed.
 */
export function scheduleFailureSentence(reason: TaskFailureReason | null | undefined): string {
  const clause = scheduleFailureClause(reason);
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/** A clock time the way every schedule line says it: `9:00`, `14:30`. */
export function scheduleClockTime(instant: Date, timeZone?: string | null): string {
  return instant
    .toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    })
    .replace(/^0/, '');
}

/** A calendar day key (`2026-11-11`) in a time zone, or the local one. */
function dayKey(instant: Date, timeZone?: string | null): string {
  return instant.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Whole calendar days from `now` to `instant`, in the given zone. */
function daysAhead(instant: Date, now: Date, timeZone?: string | null): number {
  return Math.round(
    (Date.parse(dayKey(instant, timeZone)) - Date.parse(dayKey(now, timeZone))) / 86_400_000
  );
}

/**
 * "Next try 12:00 PM." for the Needs you card: 12-hour, with a day when it
 * isn't today ("tomorrow at 9:00 AM", "Sat at 9:00 AM", "Nov 25 at 9:00 AM").
 * Every space is a no-break space, so the clause wraps as one piece.
 *
 * @param instant - When the schedule tries again.
 * @param now - The current time.
 * @param timeZone - The zone to read days and hours in; the local one when omitted.
 */
export function scheduleNextTry(instant: Date, now: Date, timeZone?: string | null): string {
  const zone = timeZone ? { timeZone } : {};
  const time = instant.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...zone,
  });
  const days = daysAhead(instant, now, timeZone);
  const day =
    days <= 0
      ? null
      : days === 1
        ? 'tomorrow'
        : days < 7
          ? instant.toLocaleDateString('en-US', { weekday: 'short', ...zone })
          : instant.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...zone });
  return `Next try ${day ? `${day} at ` : ''}${time}.`.replace(/\s/g, '\u00a0');
}

/**
 * "Next run: 9:00." held together with no-break spaces, so a narrow line wraps
 * before the clause and never leaves the time alone on the next line.
 */
export function scheduleNextClause(label: 'run' | 'try', time: string): string {
  return `Next\u00a0${label}:\u00a0${time}.`;
}

/** A standing schedule problem disappears as soon as run history becomes healthy. */
export function scheduleNeedsAttention(task: Task): boolean {
  return task.health?.state === 'failing' && task.health.streak >= 2;
}

/** What happened, after the name: "failed twice in a row" or "was blocked twice in a row". */
export function scheduleFailureVerb(blocked: boolean): string {
  return blocked ? 'was blocked twice in a row' : 'failed twice in a row';
}

/** The room line's title, using the run's recorded cause rather than current settings. */
export function scheduleFailureTitle(task: Task, blocked = isScheduleBlocked(task)): string {
  return `${scheduleNoticeName(task)} ${scheduleFailureVerb(blocked)}`;
}

/** Whether the persisted failure is a refusal rather than an execution error. */
export function isScheduleBlocked(task: Task): boolean {
  return (
    task.health?.reason?.kind === 'tool_refused' || task.health?.reason?.kind === 'tools_refused'
  );
}

/** Address one schedule's row on the Schedules page, opened to its run history. */
export function scheduleExpandHref(taskId: string): string {
  return `/tasks?expand=${encodeURIComponent(taskId)}`;
}

/** Address one actual run; this contains only app-owned identifiers. */
export function scheduleRunHref(taskId: string, runId: string): string {
  return `/tasks?schedule=${encodeURIComponent(taskId)}&run=${encodeURIComponent(runId)}`;
}
