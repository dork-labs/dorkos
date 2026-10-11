/**
 * The waiting half of the device-token poll (`pollForToken` in
 * `cloud-link-client.ts`): sleeping between polls, reading a body under a bound,
 * and how long to hold off when the cloud says too many requests.
 *
 * @module services/core/auth/device-poll-wait
 */

/**
 * Read a JSON body, giving up when `signal` aborts. The race is explicit
 * rather than left to the fetch implementation, so a body that stalls after
 * its headers ends at the bound whichever fetch delivered it.
 *
 * @param res - The response whose body to read.
 * @param signal - Ends the read when it aborts.
 */
export function readJsonUntil(res: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    res
      .json()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Wait `ms`, or less if `signal` aborts first.
 *
 * @param sleep - The injectable sleep.
 * @param ms - How long to wait.
 * @param signal - Ends the wait early when it aborts.
 */
export function sleepUnlessAborted(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    sleep(ms).then(done, done);
  });
}

/**
 * How long a 429 asks the poller to wait, in milliseconds, or 0 when it names
 * no wait (DOR-2496).
 *
 * Reads `Retry-After` (seconds, or an HTTP date) and then `X-Retry-After`
 * (seconds), and never asks to wait past the device code's expiry: past that,
 * the next poll is pointless, and the loop's own deadline check ends the link
 * as `expired`.
 *
 * @param headers - The 429 response's headers.
 * @param nowMs - The current time, epoch milliseconds.
 * @param deadlineMs - When the device code expires, epoch milliseconds.
 */
export function rateLimitWaitMs(headers: Headers, nowMs: number, deadlineMs: number): number {
  const raw = headers.get('retry-after') ?? headers.get('x-retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  const asked = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - nowMs;
  if (!Number.isFinite(asked) || asked <= 0) return 0;
  return Math.min(asked, Math.max(0, deadlineMs - nowMs));
}
