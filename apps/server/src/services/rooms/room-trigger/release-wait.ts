/** Cancellable room-release waits, so a private inbox shutdown retains no timer/listener. */
import type { ActiveClaim } from '../room-claims.js';

/** Wait for one matching release or timeout; abort resolves without retaining a callback. */
export function waitForRoomRelease(
  waiters: Set<(claim: ActiveClaim) => void>,
  timeoutMs: number,
  matches?: (claim: ActiveClaim) => boolean,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(wake);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const wake = (claim: ActiveClaim) => {
      if (matches === undefined || matches(claim)) done();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    waiters.add(wake);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}
