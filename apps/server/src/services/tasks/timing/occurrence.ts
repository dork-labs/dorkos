/**
 * Which scheduled occurrence a cron fire stands for, and whether it is still
 * worth running (DOR-2718, spec `keep-awake` Part C).
 *
 * ## Why this exists
 *
 * croner fires a job when its timer runs out, and a timer cannot run out while
 * the computer is asleep. On wake croner fires ONCE, late, and then schedules
 * the next occurrence from "now", so every other tick missed during the sleep
 * vanishes without a callback. Its `currentRun()` is the wall-clock instant of
 * that fire, not the occurrence it stands for.
 *
 * The scheduler used to key its cross-process dedupe (ADR-285) on that instant
 * floored to the minute. On an on-time fire that IS the occurrence; on a late
 * fire it names an instant that is no occurrence at all, so the run was
 * recorded against the wrong time, and two processes whose late fires
 * straddled a minute boundary claimed two different keys and both ran.
 *
 * So the key is the occurrence: the latest boundary of the schedule at or
 * before the fire, computed by croner in the job's own timezone. On an on-time
 * fire that is byte-identical to the old floored key, so the dedupe rows an
 * older build wrote keep deduping and the dispatch log needs no migration.
 *
 * @module services/tasks/timing/occurrence
 */
import type { Cron } from 'croner';

/**
 * A late run still runs only while it is under this late (operator decision,
 * DOR-2718): a daily 09:00 report runs if the computer wakes by 10:00 and not
 * after, because by then the world it would act on has moved on.
 */
export const STALE_CEILING_MS = 60 * 60 * 1000;

/**
 * A fire less than this late is on time, whatever the schedule. Only a sleeping
 * computer delays a timer this long; a busy server delays it by milliseconds,
 * and calling that "asleep" on a per-second schedule would be untrue.
 */
export const ON_TIME_GRACE_MS = 60 * 1000;

/**
 * The most missed occurrences one run counts. A per-second schedule asleep for
 * a night would otherwise count tens of thousands; the run history shows the
 * cap as "1000+".
 */
export const MISSED_TICKS_CAP = 1000;

/**
 * What a person reads on a run that was skipped for being too late. Stored as
 * the run's `error`, which the run history shows verbatim under a skipped row.
 *
 * "Asleep" is the honest common case: a fire this late means croner's timer
 * could not run, which is a sleeping computer (or, rarely, a blocked server).
 * A server that was OFF fires nothing at all, so it never writes this.
 */
export const STALE_SKIP_REASON = 'Skipped: this computer was asleep when it was due.';

/** One cron fire, resolved to the occurrence it stands for. */
export interface Occurrence {
  /** The scheduled occurrence this fire stands for: the latest boundary at or before the fire instant. */
  intendedFor: Date;
  /** `firedAt - intendedFor`, in ms. Zero or a few ms on an on-time fire. */
  lateByMs: number;
  /**
   * Occurrences from the one croner was waiting for up to (not including)
   * `intendedFor` that never fired, capped at {@link MISSED_TICKS_CAP}.
   */
  missed: number;
  /**
   * True when the run is too late to be worth running: it is at least
   * {@link ON_TIME_GRACE_MS} late, and either a full hour late or halfway or
   * more to the next occurrence.
   */
  stale: boolean;
}

/** The croner members this module reads. A paused evaluator `Cron` satisfies it. */
export type OccurrenceSchedule = Pick<Cron, 'nextRuns' | 'previousRuns'>;

/**
 * Resolve a cron fire to the occurrence it stands for.
 *
 * Pure apart from croner's own arithmetic, and deterministic in its inputs, so
 * two processes firing the same occurrence at different instants agree on it.
 *
 * @param job - The task's schedule. Pass a paused evaluator built with the same
 *   pattern and timezone as the live job: a stopped croner job answers no
 *   `nextRuns`, and an evaluator never schedules a timer.
 * @param expected - The occurrence croner was waiting for when it fired (its
 *   `nextRun()` captured at registration and after every fire), or null when
 *   unknown. Only `missed` reads it.
 * @param firedAt - The wall-clock instant the timer fired.
 * @returns The occurrence, how late the fire was, what it missed, and whether
 *   it is stale.
 */
export function resolveOccurrence(
  job: OccurrenceSchedule,
  expected: Date | null,
  firedAt: Date
): Occurrence {
  const intendedFor = latestBoundaryAtOrBefore(job, expected, firedAt);
  const lateByMs = Math.max(0, firedAt.getTime() - intendedFor.getTime());
  const [next] = job.nextRuns(1, intendedFor);
  const halfInterval = next ? (next.getTime() - intendedFor.getTime()) / 2 : Infinity;
  const stale =
    lateByMs >= ON_TIME_GRACE_MS && (lateByMs >= STALE_CEILING_MS || lateByMs >= halfInterval);
  return { intendedFor, lateByMs, missed: countMissed(job, expected, intendedFor), stale };
}

/**
 * The latest boundary of `job` at or before `firedAt`.
 *
 * croner's `previousRuns(1, ref)` drops the milliseconds of `ref` and is
 * strictly before it (measured on 10.0.1: a ref of `12:02:00.001` answers
 * `12:01:00` for a per-minute cron). So the ref is the fire instant floored to
 * its second plus one second: strictly before that, at second resolution, is
 * "at or before the fire".
 *
 * Two guards keep a croner quirk from ever moving the key backwards: the
 * answer is never after the fire, and never before the occurrence croner was
 * waiting for (croner only fires once that occurrence is due).
 */
function latestBoundaryAtOrBefore(
  job: OccurrenceSchedule,
  expected: Date | null,
  firedAt: Date
): Date {
  const ref = new Date(Math.floor(firedAt.getTime() / 1000) * 1000 + 1000);
  const due = expected && expected.getTime() <= firedAt.getTime() ? expected : null;
  let previous: Date | undefined;
  try {
    [previous] = job.previousRuns(1, ref);
  } catch {
    // croner 10.0.1's backward walk throws a TypeError from inside
    // `recurseBackward` for a reference outside the months a day-of-month
    // pattern can match: `0 0 29 2 *` or `0 0 L 2 *` asked from March, or any
    // pattern that never comes round (`0 0 31 2 *`). A leap-day task on a
    // computer asleep past March 1 fires exactly there. Losing the run's record
    // to a croner quirk is worse than keying it on the occurrence croner was
    // waiting for, which is what the guards below fall back to anyway.
    previous = undefined;
  }
  if (!previous || previous.getTime() > firedAt.getTime()) return due ?? firedAt;
  return due && due.getTime() > previous.getTime() ? due : previous;
}

/**
 * Count the boundaries in `[expected, intendedFor)`: the occurrences croner
 * was waiting for, and every one after it, that never got a fire of their own.
 *
 * Walks forward one occurrence at a time from a plain `Date` cursor, which
 * stops at the first boundary that reaches `intendedFor` rather than always
 * computing {@link MISSED_TICKS_CAP} of them, and which never repeats a
 * boundary (croner's multi-result `nextRuns` can list one twice across a DST
 * change; one at a time from a `Date` it does not).
 */
function countMissed(job: OccurrenceSchedule, expected: Date | null, intendedFor: Date): number {
  if (!expected || expected.getTime() >= intendedFor.getTime()) return 0;
  let missed = 1; // `expected` itself
  let cursor = expected;
  while (missed < MISSED_TICKS_CAP) {
    const [next] = job.nextRuns(1, cursor);
    if (!next || next.getTime() <= cursor.getTime() || next.getTime() >= intendedFor.getTime()) {
      break;
    }
    missed++;
    cursor = next;
  }
  return missed;
}
