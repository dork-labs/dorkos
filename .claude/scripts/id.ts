/**
 * id.ts — Coordination-free identifiers for new ADRs and specs.
 *
 * The historical ADR/spec numbering used a shared `nextNumber` counter in
 * `decisions/manifest.json` / `specs/manifest.json`, allocated at author-time on
 * whatever branch you happened to be on. Two branches read the same counter and
 * both allocated the same number, producing add/add file collisions and manifest
 * conflicts on merge (spec #271 / DOR-184). A timestamp id is stamped from the
 * creating process's own clock, reads no shared state, and therefore cannot
 * collide across branches regardless of ordering.
 *
 * New artifacts use a UTC `YYMMDD-HHMMSS` id. Existing 4-digit numbered artifacts
 * are frozen and keep their numbers. Because a legacy id starts with `0` and a
 * timestamp id starts with `2` (year 26+), a plain lexicographic sort lists every
 * legacy artifact first (in order) then every timestamp artifact (in order), so
 * mixed listings stay chronological with no special-casing.
 *
 * Standalone Node module (no deps); import it from other `.claude/scripts/*.ts`
 * tools or run its tests via `node --experimental-strip-types`.
 */

/** A UTC timestamp identifier of the form `YYMMDD-HHMMSS` (e.g. `260703-081234`). */
export type TimestampId = string;

/** Matches a timestamp id: six digits, a hyphen, six digits. */
const TIMESTAMP_ID_RE = /^\d{6}-\d{6}$/;

/** Matches a legacy 4-digit zero-padded id (e.g. `0294`). */
const LEGACY_ID_RE = /^\d{4}$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Generate a UTC timestamp id of the form `YYMMDD-HHMMSS`.
 *
 * @param now - Clock injection point for deterministic tests (defaults to the current time).
 */
export function generateId(now: Date = new Date()): TimestampId {
  const yy = pad2(now.getUTCFullYear() % 100);
  const mm = pad2(now.getUTCMonth() + 1);
  const dd = pad2(now.getUTCDate());
  const hh = pad2(now.getUTCHours());
  const mi = pad2(now.getUTCMinutes());
  const ss = pad2(now.getUTCSeconds());
  return `${yy}${mm}${dd}-${hh}${mi}${ss}`;
}

/** True when `s` is a timestamp id (`YYMMDD-HHMMSS`). */
export function isTimestampId(s: string): boolean {
  return TIMESTAMP_ID_RE.test(s);
}

/** True when `s` is a legacy 4-digit zero-padded id (e.g. `0294`). */
export function isLegacyId(s: string): boolean {
  return LEGACY_ID_RE.test(s);
}

/**
 * Allocate a timestamp id that is unique against a local set, bumping the clock
 * by whole seconds until free. This keeps allocation coordination-free ACROSS
 * branches (each branch stamps its own clock, so branches never need to agree)
 * while guaranteeing uniqueness WITHIN one branch when two ids are minted in the
 * same second (e.g. a batch create). It reads only local state, never a counter.
 *
 * @param taken - Predicate returning true when an id is already in use locally.
 * @param now - Starting clock (defaults to the current time); injectable for tests.
 */
export function allocateId(taken: (id: string) => boolean, now: Date = new Date()): TimestampId {
  let d = now;
  let id = generateId(d);
  while (taken(id)) {
    d = new Date(d.getTime() + 1000);
    id = generateId(d);
  }
  return id;
}

/**
 * Parse a timestamp id back to its UTC `Date` (seconds precision), or `null` when
 * `id` is not a timestamp id. The two-digit year is interpreted as `20YY`.
 *
 * @param id - The id to parse.
 */
export function parseIdDate(id: string): Date | null {
  if (!isTimestampId(id)) return null;
  const yy = Number(id.slice(0, 2));
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  const hh = Number(id.slice(7, 9));
  const mi = Number(id.slice(9, 11));
  const ss = Number(id.slice(11, 13));
  return new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi, ss));
}

// CLI: print a fresh timestamp id when run directly (e.g. for /adr:create):
//   node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/id.ts
if (import.meta.filename === process.argv[1]) {
  process.stdout.write(generateId() + '\n');
}
