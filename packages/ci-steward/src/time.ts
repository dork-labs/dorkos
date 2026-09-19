/**
 * Dates, windows and percentiles. Every function takes its clock or its day as
 * an argument: nothing here reads the real time, so no fixture can turn into a
 * time bomb when the calendar moves on.
 *
 * Days are UTC calendar days written `YYYY-MM-DD`. Weeks are ISO weeks,
 * Monday 00:00 UTC to Monday 00:00 UTC, written `YYYY-Www`.
 */

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The UTC day an instant falls on.
 *
 * @param d - The instant.
 */
export function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * True when `s` is a real `YYYY-MM-DD` calendar day.
 *
 * @param s - The candidate.
 */
export function isDay(s: string): boolean {
  return DAY_RE.test(s) && dayOf(new Date(`${s}T00:00:00Z`)) === s;
}

/**
 * Midnight UTC at the start of a day.
 *
 * @param day - A `YYYY-MM-DD` day.
 */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/**
 * The day `n` days after `day` (negative for before).
 *
 * @param day - A `YYYY-MM-DD` day.
 * @param n - Days to add.
 */
export function addDays(day: string, n: number): string {
  return dayOf(new Date(dayStart(day).getTime() + n * DAY_MS));
}

/**
 * Every day from `from` to `to`, both included, oldest first.
 *
 * @param from - First day.
 * @param to - Last day.
 */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Whole minutes between two ISO timestamps, as a float.
 *
 * @param from - Start.
 * @param to - End.
 */
export function minutesBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}

/**
 * The ISO week of an instant, e.g. `2026-W38`.
 *
 * @param d - The instant.
 */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The Monday that starts the ISO week holding `day`.
 *
 * @param day - A `YYYY-MM-DD` day.
 */
export function weekMonday(day: string): string {
  const dow = dayStart(day).getUTCDay() || 7;
  return addDays(day, 1 - dow);
}

/**
 * The `q` quantile by linear interpolation, the method every research number
 * in `research/20260919_ci-pipeline-*` used, so a snapshot reproduces them.
 *
 * @param xs - The sample; need not be sorted.
 * @param q - The quantile, 0 to 1.
 * @returns `null` for an empty sample.
 */
export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * q;
  const f = Math.floor(k);
  const c = Math.min(f + 1, s.length - 1);
  return s[f]! + (s[c]! - s[f]!) * (k - f);
}

/**
 * Round to a fixed number of decimals, so snapshots stay small and diffable.
 *
 * @param x - The value.
 * @param places - Decimal places (default 2).
 */
export function round(x: number, places = 2): number {
  const m = 10 ** places;
  return Math.round(x * m) / m;
}

/**
 * Seconds since the start of the UTC day an ISO instant falls on.
 *
 * @param isoTime - The instant.
 */
export function secondOfDay(isoTime: string): number {
  const ms = Date.parse(isoTime);
  return Math.floor((ms - dayStart(dayOf(new Date(ms))).getTime()) / 1000);
}
