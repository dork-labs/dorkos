/**
 * Timestamp ids for ledger entries: UTC `YYMMDD-HHMMSS`.
 *
 * The same format and timezone as the repo's ADR and spec ids
 * (`.claude/scripts/id.ts`, ADR-0312). It is re-implemented here rather than
 * imported because this package may import nothing outside itself (its
 * dependency budget), so it can move to a marketplace plugin unchanged.
 */

const TIMESTAMP_ID_RE = /^\d{6}-\d{6}$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Format a UTC timestamp id for `now`.
 *
 * @param now - The clock; callers always pass it, so tests never depend on the real date.
 */
function generateId(now: Date): string {
  const yy = pad2(now.getUTCFullYear() % 100);
  return (
    `${yy}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}-` +
    `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`
  );
}

/**
 * True when `s` has the `YYMMDD-HHMMSS` shape and names a real UTC instant.
 *
 * @param s - The candidate id.
 */
export function isTimestampId(s: string): boolean {
  if (!TIMESTAMP_ID_RE.test(s)) return false;
  const d = parseIdDate(s);
  return d !== null && generateId(d) === s;
}

/**
 * Parse an id back to its UTC instant, or `null` when it is not an id.
 *
 * @param id - A `YYMMDD-HHMMSS` id; the two-digit year means `20YY`.
 */
function parseIdDate(id: string): Date | null {
  if (!TIMESTAMP_ID_RE.test(id)) return null;
  const n = (a: number, b: number) => Number(id.slice(a, b));
  return new Date(Date.UTC(2000 + n(0, 2), n(2, 4) - 1, n(4, 6), n(7, 9), n(9, 11), n(11, 13)));
}

/**
 * Allocate an id not yet taken, bumping the clock a second at a time.
 *
 * @param taken - True when an id is already used locally.
 * @param now - The starting clock.
 */
export function allocateId(taken: (id: string) => boolean, now: Date): string {
  let d = now;
  let id = generateId(d);
  while (taken(id)) {
    d = new Date(d.getTime() + 1000);
    id = generateId(d);
  }
  return id;
}
