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
