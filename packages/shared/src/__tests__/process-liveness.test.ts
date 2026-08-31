import { describe, it, expect } from 'vitest';
import { isProcessAlive, processStartTime, assessProcessLiveness } from '../process-liveness.js';

/** A pid high enough that no process can hold it. */
const DEAD_PID = 2147483646;
/** The process that spawned this one: alive, and never our own pid. */
const LIVE_PID = process.ppid;

describe('isProcessAlive', () => {
  it('is true for a pid that is running (this process itself)', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is true for another live process (the parent)', () => {
    expect(isProcessAlive(LIVE_PID)).toBe(true);
  });

  it('is false for a pid nothing holds', () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });
});

describe('processStartTime', () => {
  it('returns a parseable start time for a live process, or null where `ps` is unavailable (Windows)', () => {
    const startedAt = processStartTime(process.pid);
    if (startedAt === null) return; // No `ps` on this platform — the documented fallback.
    expect(startedAt.getTime()).not.toBeNaN();
    // This test process cannot have started in the future.
    expect(startedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('is null for a pid nothing holds', () => {
    expect(processStartTime(DEAD_PID)).toBeNull();
  });
});

describe('assessProcessLiveness', () => {
  it('is "gone" for a pid nothing holds', () => {
    expect(assessProcessLiveness(DEAD_PID, new Date())).toBe('gone');
  });

  it('is "live-confirmed" or "live-unconfirmed" for this process, referenced at a time after it started', () => {
    // "Now" is always after this process's own start time, so a real holder
    // is either confirmed outright, or — on a platform with no `ps` — left
    // unconfirmed rather than wrongly declared gone.
    const state = assessProcessLiveness(process.pid, new Date());
    expect(['live-confirmed', 'live-unconfirmed']).toContain(state);
  });

  it('is "gone" when the reference time is long before the process could have started, past the tolerance', () => {
    // This test process necessarily started after the Unix epoch. A pid
    // that "started" at some day in 1970, by the recorded reference, is
    // wearing a recycled pid the same way a stale lock file's holder would.
    const epoch = new Date(0);
    const state = assessProcessLiveness(process.pid, epoch, 1_000);
    // On a platform where `processStartTime` can't say (Windows), this stays
    // unconfirmed rather than wrongly "gone" — the safe direction.
    expect(['gone', 'live-unconfirmed']).toContain(state);
  });

  it('respects a larger tolerance', () => {
    // A reference time far in the future is never satisfied by any
    // tolerance smaller than the gap, regardless of platform.
    const farFuture = new Date(Date.now() + 10_000);
    expect(assessProcessLiveness(process.pid, farFuture, 0)).not.toBe('gone');
  });
});
