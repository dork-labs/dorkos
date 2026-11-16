/**
 * Viewer-local schedule descriptions and wrong-zone detection for task rows.
 *
 * @module features/tasks/lib/task-time
 */
import cronstrue from 'cronstrue';
import type { Task } from '@dorkos/shared/types';

/** A cron expression's one fixed wall-clock time. */
export interface FixedCronTime {
  /** Minute from 0 through 59. */
  minute: number;
  /** Hour from 0 through 23. */
  hour: number;
}

/** The values needed to render the quiet wrong-zone offer. */
export interface WrongTimezoneOfferDetails {
  /** The schedule's zone as a person reads it. */
  scheduleZone: string;
  /** The cron's wall-clock time in its own zone. */
  scheduleTime: string;
  /** The next run's wall-clock time in the viewer's zone. */
  viewerTime: string;
}

/**
 * Read one fixed minute and hour from a five-field cron expression.
 *
 * @param cron - The cron expression.
 * @returns Its fixed time, or `null` when either field varies.
 */
export function fixedCronTime(cron: string): FixedCronTime | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || !/^\d+$/.test(fields[0]!) || !/^\d+$/.test(fields[1]!)) {
    return null;
  }
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  return minute <= 59 && hour <= 23 ? { minute, hour } : null;
}

/**
 * Describe a cron expression in 12-hour time.
 *
 * @param cron - The cron expression.
 * @returns A readable description, or the original expression when cronstrue cannot read it.
 */
export function describeCronSchedule(cron: string): string {
  try {
    return compactCronText(
      cronstrue.toString(cron, {
        use24HourTimeFormat: false,
      })
    );
  } catch {
    return cron;
  }
}

/**
 * Describe a task's cadence in the viewer's time whenever conversion is unambiguous.
 *
 * @param task - The scheduled task.
 * @param viewerTimezone - The viewer's IANA zone.
 * @returns The cadence text for the row.
 */
export function describeTaskTiming(task: Task, viewerTimezone: string): string {
  if (!task.cron) return 'On-demand';
  const description = describeCronSchedule(task.cron);
  if (!task.timezone || scheduleZoneLabel(task.timezone) === scheduleZoneLabel(viewerTimezone)) {
    return description;
  }

  const fixed = fixedCronTime(task.cron);
  // Swapping in the viewer's clock is only honest when the day words can't
  // shift with it: a weekday cron at 02:00 UTC is Sunday through Thursday
  // evening in Chicago, not "Weekdays".
  const everyDay = task.cron
    .trim()
    .split(/\s+/)
    .slice(2)
    .every((field) => field === '*');
  if (
    fixed &&
    task.nextRun &&
    (everyDay || sameDayInBothZones(task.nextRun, task.timezone, viewerTimezone))
  ) {
    const viewerTime = formatInstantTime(task.nextRun, viewerTimezone);
    if (viewerTime) {
      const replaced = description.replace(/\b\d{1,2}:\d{2}\s+[AP]M\b/i, viewerTime);
      if (replaced !== description) return replaced;
    }
  }
  return `${description}, ${scheduleZoneLabel(task.timezone)}`;
}

/**
 * Format the next run with a short viewer-local day and a 12-hour clock.
 *
 * @param nextRun - The next run instant.
 * @param viewerTimezone - The viewer's IANA zone.
 * @param now - Clock injection for deterministic tests.
 * @returns Text beginning with “Next”, or `null` for an unreadable instant.
 */
export function formatNextRun(
  nextRun: string,
  viewerTimezone: string,
  now: Date = new Date()
): string | null {
  const next = new Date(nextRun);
  if (Number.isNaN(next.getTime())) return null;
  try {
    const difference = calendarDay(next, viewerTimezone) - calendarDay(now, viewerTimezone);
    const day =
      difference === 0
        ? 'today'
        : difference === 1
          ? 'tomorrow'
          : difference > 1 && difference < 7
            ? new Intl.DateTimeFormat('en-US', {
                timeZone: viewerTimezone,
                weekday: 'short',
              }).format(next)
            : new Intl.DateTimeFormat('en-US', {
                timeZone: viewerTimezone,
                month: 'short',
                day: 'numeric',
              }).format(next);
    return `Next ${day} ${formatInstantTime(nextRun, viewerTimezone)}`;
  } catch {
    return null;
  }
}

/**
 * Build the wrong-zone offer when the next fixed-time run lands overnight.
 *
 * @param task - The scheduled task.
 * @param viewerTimezone - The viewer's IANA zone.
 * @returns Offer text values, or `null` when no offer belongs on the row.
 */
export function wrongTimezoneOffer(
  task: Task,
  viewerTimezone: string
): WrongTimezoneOfferDetails | null {
  if (
    !task.cron ||
    !task.timezone ||
    scheduleZoneLabel(task.timezone) === scheduleZoneLabel(viewerTimezone) ||
    !task.nextRun
  ) {
    return null;
  }
  const fixed = fixedCronTime(task.cron);
  if (!fixed) return null;
  try {
    const next = new Date(task.nextRun);
    if (Number.isNaN(next.getTime())) return null;
    const hourPart = new Intl.DateTimeFormat('en-US', {
      timeZone: viewerTimezone,
      hour: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(next)
      .find((part) => part.type === 'hour')?.value;
    const viewerTime = formatInstantTime(task.nextRun, viewerTimezone);
    const hour = Number(hourPart);
    if (!viewerTime || !Number.isInteger(hour) || hour < 0 || hour >= 6) return null;
    return {
      scheduleZone: scheduleZoneLabel(task.timezone),
      scheduleTime: formatWallTime(fixed),
      viewerTime,
    };
  } catch {
    return null;
  }
}

/**
 * Use the short UTC name for UTC aliases and the IANA id for every other zone.
 *
 * @param timezone - The stored schedule zone.
 * @returns The label shown in task timing copy.
 */
export function scheduleZoneLabel(timezone: string): string {
  return timezone === 'UTC' || timezone === 'Etc/UTC' ? 'UTC' : timezone;
}

/** Make common cronstrue output shorter without changing its meaning. */
function compactCronText(text: string): string {
  const weekdays = text.match(/^At (\d{1,2}:\d{2}\s+[AP]M), Monday through Friday$/i);
  if (weekdays) return `Weekdays at ${stripLeadingHourZero(weekdays[1]!)}`;
  // Every day at one time: "Daily at 2:30 AM", never a bare "At 02:30 AM".
  const daily = text.match(/^At (\d{1,2}:\d{2}\s+[AP]M)$/i);
  if (daily) return `Daily at ${stripLeadingHourZero(daily[1]!)}`;
  return text.replace(/\b0(\d:\d{2}\s+[AP]M)\b/gi, '$1');
}

/** Remove cronstrue's leading zero from a 12-hour clock value. */
function stripLeadingHourZero(time: string): string {
  return time.replace(/^0/, '');
}

/** Format one instant in a zone without seconds. */
function formatInstantTime(instant: string, timezone: string): string | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/** Format a cron's own fixed wall-clock time without applying a zone. */
function formatWallTime({ hour, minute }: FixedCronTime): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(Date.UTC(2020, 0, 1, hour, minute)));
}

/** Whether one instant falls on the same calendar day in two zones. */
function sameDayInBothZones(instant: string, zoneA: string, zoneB: string): boolean {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return false;
  try {
    return calendarDay(date, zoneA) === calendarDay(date, zoneB);
  } catch {
    return false;
  }
}

/** Turn a zoned calendar date into a day number suitable for nearby comparisons. */
function calendarDay(date: Date, timezone: string): number {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      values[part.type] = Number(part.value);
    }
  }
  return Date.UTC(values.year!, values.month! - 1, values.day!) / 86_400_000;
}
