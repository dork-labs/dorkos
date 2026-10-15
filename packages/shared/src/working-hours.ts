/**
 * A person's working hours, computed in their own time zone (spec `heartbeats`
 * §3.5).
 *
 * Hours belong to people, not agents: an agent's hours are its chain person's.
 * They never limit work. They set when a message to a person is delivered and
 * the rhythm an agent checks in at, so the one thing these helpers must get
 * right is the person's wall clock, on every day of the year.
 *
 * Every computation goes through `Intl` in the person's zone, so a daylight
 * saving change moves the window with the clock (09:00 stays 09:00) rather than
 * sliding it an hour. Pure and dependency-free: the server, the client and the
 * tests all use the same functions.
 *
 * @module shared/working-hours
 */
import { isValidTimeZone, type WorkingHours } from './config-schema.js';

export { isValidTimeZone };

/** Monday to Friday, 09:00 to 17:00 — what `workingHours: null` means. */
export const DEFAULT_WORKING_HOURS: WorkingHours = Object.freeze({
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '17:00',
}) as WorkingHours;

/** A person's hours, made concrete: a real zone and a real window. */
export interface ResolvedWorkingHours {
  /** IANA time zone the window is read in. */
  timezone: string;
  /** Working days, 0 = Sunday … 6 = Saturday, sorted and unique. */
  days: number[];
  /** When the day starts, `HH:MM` on a 24-hour clock. */
  start: string;
  /** When the day ends, `HH:MM`, always after `start`. */
  end: string;
}

/** The two profile fields the window is built from. */
export interface WorkingHoursProfile {
  /** IANA zone, or `null` while the app has not told the server one. */
  timezone?: string | null;
  /** The window, or `null` for {@link DEFAULT_WORKING_HOURS}. */
  workingHours?: WorkingHours | null;
}

/** The zone this process runs in, the stand-in while a person has not set one. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * A person's hours as a concrete window.
 *
 * `timezone: null` reads as `fallbackZone` (the server's own zone, until the app
 * seeds the browser's), and `workingHours: null` as Monday to Friday, 09:00 to
 * 17:00. A stored zone this runtime cannot read also falls back, rather than
 * making every later computation throw.
 *
 * @param profile - The person's `profile` config block, or nothing.
 * @param fallbackZone - The zone to use when none is stored. Defaults to this
 *   process's own.
 */
export function resolveWorkingHours(
  profile: WorkingHoursProfile | null | undefined,
  fallbackZone: string = systemTimeZone()
): ResolvedWorkingHours {
  const stored = profile?.timezone;
  const timezone = stored && isValidTimeZone(stored) ? stored : fallbackZone;
  const window = profile?.workingHours ?? DEFAULT_WORKING_HOURS;
  return {
    timezone,
    days: [...new Set(window.days)].sort((a, b) => a - b),
    start: window.start,
    end: window.end,
  };
}

/** One instant's wall clock in a zone. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

/** Formatters are expensive to build; one per zone is plenty. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The cached formatter for a zone. */
function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** What the clock on the wall says in `zone` at `epochMs`. */
function zonedParts(epochMs: number, zone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(epochMs))) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
  };
}

/** How far `zone` is ahead of UTC at `epochMs`, in milliseconds. */
function offsetAt(epochMs: number, zone: string): number {
  const p = zonedParts(epochMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** `HH:MM` as minutes after midnight. */
function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * The instant a wall-clock time happens in `zone`.
 *
 * Disambiguates the way `Temporal`'s `'compatible'` mode does: a time that
 * happens twice (the hour the clocks go back) is the first of the two, and a
 * time that never happens (the hour they go forward) is read with the offset
 * from before the jump, which lands it the same distance past the gap. So a day
 * that starts at 02:30 on the night the clocks skip 02:00–03:00 starts at 03:30.
 */
function instantOf(year: number, month: number, day: number, clock: string, zone: string): number {
  const minutes = minutesOf(clock);
  const wall = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  const before = wall - offsetAt(wall - 86_400_000, zone);
  const after = wall - offsetAt(wall + 86_400_000, zone);
  const matches = (t: number): boolean => {
    const p = zonedParts(t, zone);
    return (
      p.year === year && p.month === month && p.day === day && p.hour * 60 + p.minute === minutes
    );
  };
  const candidates = [before, after].filter(matches);
  // Both match: the repeated hour, and the earlier is the first time it happens.
  if (candidates.length > 0) return Math.min(...candidates);
  // Neither matches: the skipped hour, read with the offset from before the jump.
  return Math.max(before, after);
}

/**
 * The instant a calendar day and wall-clock time happen in a zone — "the 20th
 * at 00:00 in Berlin" — with the daylight-saving disambiguation
 * {@link nextWorkingStart} uses.
 *
 * @param day - The calendar day, `YYYY-MM-DD`.
 * @param clock - The time on the wall, `HH:MM`.
 * @param zone - The IANA zone to read it in.
 */
export function zonedInstant(day: string, clock: string, zone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(instantOf(year ?? 1970, month ?? 1, date ?? 1, clock, zone));
}

/**
 * The calendar day an instant falls on in a zone, `YYYY-MM-DD`.
 *
 * @param date - The instant.
 * @param zone - The IANA zone to read it in.
 */
export function zonedDay(date: Date, zone: string): string {
  const p = zonedParts(date.getTime(), zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Whether `date` falls inside the person's working hours.
 *
 * Inside means on a working day in their zone, at or after `start` and before
 * `end` — so a window of 09:00–17:00 includes 09:00:00 and excludes 17:00:00.
 *
 * @param date - The moment to test.
 * @param hours - The person's window, from {@link resolveWorkingHours}.
 */
export function isWithinWorkingHours(date: Date, hours: ResolvedWorkingHours): boolean {
  const p = zonedParts(date.getTime(), hours.timezone);
  if (!hours.days.includes(p.weekday)) return false;
  const now = p.hour * 60 + p.minute;
  return now >= minutesOf(hours.start) && now < minutesOf(hours.end);
}

/**
 * The first moment at or after `date` when the person's working day starts.
 *
 * A start, not "now if they are working": called at 10:00 on a Monday with a
 * 09:00 start, it answers Tuesday 09:00. A caller holding a message asks
 * {@link isWithinWorkingHours} first and only waits when that says no.
 *
 * @param date - Where to look from.
 * @param hours - The person's window, from {@link resolveWorkingHours}.
 * @returns The instant their next working day opens, or `null` when the window
 *   names no working day at all.
 */
export function nextWorkingStart(date: Date, hours: ResolvedWorkingHours): Date | null {
  if (hours.days.length === 0) return null;
  const from = date.getTime();
  const today = zonedParts(from, hours.timezone);
  // Eight days covers every weekday once, plus today's own start already gone.
  for (let offset = 0; offset <= 8; offset++) {
    // Calendar arithmetic on a UTC date, so month and year ends roll over and no
    // zone's offset can skip or repeat a day.
    const calendar = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!hours.days.includes(calendar.getUTCDay())) continue;
    const start = instantOf(
      calendar.getUTCFullYear(),
      calendar.getUTCMonth() + 1,
      calendar.getUTCDate(),
      hours.start,
      hours.timezone
    );
    if (start >= from) return new Date(start);
  }
  return null;
}
