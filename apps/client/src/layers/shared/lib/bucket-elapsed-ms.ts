/**
 * How long ago, as a number and a unit — before anyone picks the words.
 *
 * Four functions in three files each re-derived the same minute/hour/day
 * cascade with their own `MINUTE_MS`/`HOUR_MS`/`DAY_MS` constants, one file
 * twice over (DOR-1763 finding 17.11). The *words* genuinely differ — "45m
 * ago" for a session list, "5m" for a dense row, "45 min" mid-sentence — and
 * that is settled. The arithmetic under them never needed to.
 *
 * @module shared/lib/bucket-elapsed-ms
 */

/** Milliseconds in a minute. */
const MINUTE_MS = 60_000;

/** Minutes in an hour. */
const MINUTES_PER_HOUR = 60;

/** Hours in a day. */
const HOURS_PER_DAY = 24;

/** An elapsed span, floored to the largest unit that still counts at least one. */
export interface ElapsedBucket {
  /** How many whole units elapsed. `0` only ever happens with `minute`. */
  value: number;
  /** The largest unit that fits. */
  unit: 'minute' | 'hour' | 'day';
}

/**
 * Bucket an elapsed span into whole minutes, hours, or days.
 *
 * Floors rather than rounds, so nothing is ever reported as older than it is.
 * A negative span — clock skew between a server and a browser — reads as zero
 * minutes rather than a time in the future.
 *
 * @param ms - Milliseconds elapsed.
 * @returns The count and the unit it counts.
 */
export function bucketElapsedMs(ms: number): ElapsedBucket {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (minutes < MINUTES_PER_HOUR) return { value: minutes, unit: 'minute' };
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return { value: hours, unit: 'hour' };
  return { value: Math.floor(hours / HOURS_PER_DAY), unit: 'day' };
}
