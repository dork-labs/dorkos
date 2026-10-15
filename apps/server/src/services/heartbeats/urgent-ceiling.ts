/**
 * The one ceiling on urgent raises (spec `heartbeats` §9.2): at most
 * {@link URGENT_PER_PERSON_PER_HOUR} reach one person in any hour, from every
 * agent together and on every rung, a room post included.
 *
 * Counted by when each one reaches the person, not when it was raised: a raise
 * held past the ceiling counts at the moment it is due, and one that went out
 * counts at the moment it went. So a burst held to the end of the window can
 * never arrive as a second burst on top of the next hour's share.
 *
 * @module services/heartbeats/urgent-ceiling
 */

/** One hour, in ms. */
export const HOUR_MS = 60 * 60_000;

/** The most urgent raises one person gets in an hour, from every agent together. */
export const URGENT_PER_PERSON_PER_HOUR = 6;

/**
 * Whether one more urgent message at `at` keeps every hour that holds it
 * within the ceiling.
 *
 * @param moments - When the person's other urgent messages arrive (epoch ms).
 * @param at - The candidate moment.
 */
function fits(moments: readonly number[], at: number): boolean {
  // Every hour-long window [start, start + 1h) that holds `at` starts in
  // (at - 1h, at]; its count only changes at a moment, so those are the starts
  // worth checking.
  const starts = [at, ...moments.filter((m) => m > at - HOUR_MS && m <= at)];
  return starts.every(
    (start) =>
      moments.filter((m) => m >= start && m < start + HOUR_MS).length < URGENT_PER_PERSON_PER_HOUR
  );
}

/**
 * The earliest moment at or after `now` an urgent message may reach a person.
 *
 * @param moments - When their other urgent messages arrive or arrived, the
 *   held ones included (epoch ms, any order).
 * @param now - Epoch ms.
 * @returns `now` when it may go now, else the first moment a window frees up.
 */
export function urgentDeliveryTime(moments: readonly number[], now: number): number {
  const candidates = [now, ...moments.map((m) => m + HOUR_MS).filter((m) => m > now)].sort(
    (a, b) => a - b
  );
  return candidates.find((at) => fits(moments, at)) ?? now;
}
