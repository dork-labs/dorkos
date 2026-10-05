import { RateLimited } from '../http.js';

/**
 * The shared per-minute attempt limiter every older per-caller and per-account limit spends from
 * (`app.ts`): sign-ups, bootstrap, invite previews, pairings, host keys, password guesses.
 *
 * It holds at most `maxKeys` keys; when full it drops keys idle for a minute, then its oldest key.
 * That last step means spraying keys into it can evict another key's budget, which is why mailed
 * links keep their own store (`email-links/limiter.ts`).
 */
export function createAttemptLimiter(maxKeys = 10_000) {
  const attemptTimes = new Map<string, number[]>();
  /** Spend one attempt under `key`, or throw `429 RATE_LIMITED` once `ceiling` is spent. */
  const limitAttempts = (key: string, ceiling: number) => {
    const now = Date.now();
    if (attemptTimes.size > maxKeys) {
      for (const [address, times] of attemptTimes) {
        if (times.at(-1)! < now - 60_000) attemptTimes.delete(address);
      }
      if (attemptTimes.size > maxKeys) attemptTimes.delete(attemptTimes.keys().next().value!);
    }
    const current = (attemptTimes.get(key) ?? []).filter((time) => now - time < 60_000);
    if (current.length >= ceiling)
      // The oldest attempt still in the window is the next one to free a slot.
      throw new RateLimited(
        'Too many attempts. Try again soon.',
        Math.max(1, Math.ceil((current[0] + 60_000 - now) / 1000))
      );
    current.push(now);
    attemptTimes.set(key, current);
  };
  /** Give back the most recent attempt spent under `key`, as for a confirmed password. */
  const refundAttempt = (key: string) => {
    attemptTimes.get(key)?.pop();
  };
  return { limitAttempts, refundAttempt };
}
