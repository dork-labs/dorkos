/**
 * How long is left to answer, in plain words.
 *
 * Shared by both card families, which is why it lives here rather than beside
 * either of them: a capability approval measures its window in hours and an Ask
 * measures it in minutes, and both say it the same way.
 *
 * @module features/ask/lib/format-time-left
 */

/**
 * How long an operator has left to decide, in plain words.
 *
 * The decision window is measured in hours, not minutes (`APPROVAL_TTL_MS`), so
 * the phrase has to stay readable above the hour mark: "119 min left" is a
 * number, not information.
 *
 * @param expiresAt - ISO 8601 timestamp when the approval stops being honored.
 * @param now - The current time in epoch milliseconds.
 * @returns A short phrase like `1 hr 5 min left` or `8 min left`; `expiring`
 *   inside the last minute, and `expired` once the window has closed.
 */
export function formatTimeLeft(expiresAt: string, now: number): string {
  const msLeft = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(msLeft) || msLeft <= 0) return 'expired';
  const minutesLeft = Math.floor(msLeft / 60_000);
  if (minutesLeft < 1) return 'expiring';
  if (minutesLeft < 60) return `${minutesLeft} min left`;
  const hours = Math.floor(minutesLeft / 60);
  const minutes = minutesLeft % 60;
  return minutes === 0 ? `${hours} hr left` : `${hours} hr ${minutes} min left`;
}

/**
 * The same phrase, for a countdown already reduced to seconds.
 *
 * An Ask ticks locally off its own start time, so it holds seconds rather than a
 * deadline string. Under a minute it counts down by the second, because the last
 * minute is the one where a number matters.
 *
 * @param secondsLeft - Seconds until the prompt auto-denies.
 * @returns e.g. `4 min left`, `35s left`, `expired`.
 */
export function formatAskTimeLeft(secondsLeft: number): string {
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) return 'expired';
  if (secondsLeft < 60) return `${Math.ceil(secondsLeft)}s left`;
  return `${Math.floor(secondsLeft / 60)} min left`;
}
