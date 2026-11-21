/** Clock handoff for the private native guardian and the existing run port. */
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';

export const WINDOWS_STARTUP_LIMIT_MS = 300_000;
export const WINDOWS_STOP_LIMIT_MS = 5000;
const ORDINARY_GRACE_LIMIT_MS = 3000;
const systemClock = {
  wallNow: Date.now,
  monotonicNow: () => performance.now(),
  setTimer: setTimeout,
  clearTimer: clearTimeout,
};

function countdown(deadline, clock) {
  const remainingMs = () => Math.max(0, Math.floor(deadline - clock.monotonicNow()));
  const arm = (onExpired) => {
    const timer = clock.setTimer(onExpired, remainingMs());
    return () => clock.clearTimer(timer);
  };
  return {
    remainingMs,
    arm,
    wait(work, expired) {
      let cancel;
      const observed = Promise.resolve(work).then((value) => {
        if (remainingMs() === 0) throw expired;
        return value;
      });
      const expiry = new Promise((_, reject) => {
        cancel = arm(() => reject(expired));
      });
      return Promise.race([observed, expiry]).finally(cancel);
    },
  };
}

export function windowsDuration(durationMs, maximumMs, clock = systemClock) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > maximumMs) {
    throw new RangeError('Invalid Windows guardian duration');
  }
  return countdown(clock.monotonicNow() + durationMs, clock);
}

/** Project the existing port's wall timestamp once, before queuing native work. */
export function captureWindowsPortDeadline(deadline, maximumMs, clock = systemClock) {
  if (!Number.isFinite(deadline)) throw new RangeError('A finite custody deadline is required');
  const capturedAt = clock.monotonicNow();
  const duration = Math.max(0, Math.min(maximumMs, Math.floor(deadline - clock.wallNow())));
  return countdown(capturedAt + duration, clock);
}

/** Keep ordinary application grace and guardian confirmation inside one port stop window. */
export async function stopWindowsGuardianFromPort(
  { deadline, waitForOrdinaryStop, requestNativeStop },
  clock = systemClock
) {
  const stop = captureWindowsPortDeadline(deadline, WINDOWS_STOP_LIMIT_MS, clock);
  let ordinary = { kind: 'not-requested' };
  if (waitForOrdinaryStop) {
    const grace = windowsDuration(
      Math.min(ORDINARY_GRACE_LIMIT_MS, stop.remainingMs()),
      ORDINARY_GRACE_LIMIT_MS,
      clock
    );
    if (grace.remainingMs() > 0) {
      try {
        await grace.wait(
          waitForOrdinaryStop(),
          new Error('Windows ordinary stop did not finish within grace')
        );
        ordinary = { kind: 'finished' };
      } catch (error) {
        ordinary = { kind: 'unconfirmed', error };
      }
    }
  }

  try {
    const result = await stop.wait(
      requestNativeStop(stop.remainingMs()),
      new Error('Windows guardian cleanup remains unconfirmed')
    );
    return { ordinary, native: { kind: 'reported', result } };
  } catch (error) {
    return { ordinary, native: { kind: 'unconfirmed', error } };
  }
}
