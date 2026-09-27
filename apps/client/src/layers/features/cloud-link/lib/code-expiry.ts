/**
 * How a pending link code's remaining lifetime is put into words.
 *
 * Two readings of the same clock, for two audiences. The visible one counts
 * down (`4:12`) until the last minute, where it switches to "less than a
 * minute": past that point the number stops being useful and starts being a
 * stressor. The spoken one changes only at thresholds, so a screen reader hears
 * a sentence when the pending view opens, at five minutes and at one, never
 * one per second.
 *
 * @module features/cloud-link/lib/code-expiry
 */

/** Below this, both readings stop counting and say "less than a minute". */
const LAST_MINUTE_MS = 60_000;

/** The middle spoken threshold, for a code that starts with more than this. */
const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * Milliseconds from `now` until `expiresAt`, never negative, or `null` when
 * `expiresAt` is not a readable timestamp (the countdown is then left out
 * rather than showing a made-up time).
 */
export function msUntilExpiry(expiresAt: string, now: number): number | null {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * The visible countdown sentence: `This code expires in 4:12.`, or
 * `This code expires in less than a minute.` in the last minute.
 *
 * At zero it keeps the last-minute wording rather than declaring the code
 * expired: the server is the one that says so, and the panel swaps to its
 * expired state on the next status poll.
 */
export function visibleExpiry(msLeft: number): string {
  if (msLeft < LAST_MINUTE_MS) return 'This code expires in less than a minute.';
  const totalSeconds = Math.floor(msLeft / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `This code expires in ${minutes}:${String(seconds).padStart(2, '0')}.`;
}

/**
 * The spoken sentence for a screen reader. It changes only at thresholds, so
 * the live region it sits in is announced when the code appears, when five
 * minutes are left (if the code started with more), and when the last minute
 * starts, never once a second.
 *
 * @param msAtEntry - time left when the pending view opened, frozen by the caller
 * @param msLeft - time left now
 */
export function spokenExpiry(msAtEntry: number, msLeft: number): string {
  if (msLeft < LAST_MINUTE_MS) return 'This code expires in less than a minute.';
  if (msLeft < FIVE_MINUTES_MS && msAtEntry >= FIVE_MINUTES_MS) {
    return 'This code expires in less than 5 minutes.';
  }
  const minutes = Math.max(1, Math.floor(msAtEntry / 60_000));
  return `This code expires in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}
