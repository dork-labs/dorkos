/**
 * How long an operator has left to decide, in plain words.
 *
 * @param expiresAt - ISO 8601 timestamp when the approval stops being honored.
 * @param now - The current time in epoch milliseconds.
 * @returns A short phrase like `8 min left`, or `expiring` inside the last minute.
 */
export function formatTimeLeft(expiresAt: string, now: number): string {
  const msLeft = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(msLeft) || msLeft <= 0) return 'expired';
  const minutesLeft = Math.floor(msLeft / 60_000);
  if (minutesLeft < 1) return 'expiring';
  return `${minutesLeft} min left`;
}
