/**
 * Recycled-pid-safe liveness checks.
 *
 * ## Nothing here is measured against a later clock reading (DOR-1716)
 *
 * `processStartTime` reads `ps -o lstart=`, which prints whole seconds — so the
 * value it returns is quantized by up to a second in a direction the platform
 * chooses (measured on macOS: it truncates; `procps` on Linux derives `lstart`
 * from `btime + start_jiffies/Hz`, and `btime` is itself `now − uptime`). This
 * suite used to assert `startedAt <= Date.now()`, which reads as a safe claim —
 * a process cannot start in the future — and is not one: the whole margin was
 * the sub-second remainder of the moment the worker happened to launch, and a
 * vitest worker reaches this file about **70ms** into its own life, so there was
 * no engineered headroom at all. A `ps` that rounds instead of truncating, or a
 * `btime` off by a second (which the module's own doc names as routine, from NTP
 * correcting an RTC or a VM resuming from a snapshot), puts the reading past the
 * assertion's reference and reds it — `expected <ts> to be <= <ts>`.
 *
 * The reference is now this process's OWN start instant, taken from
 * `process.uptime()`. Both sides then describe the same physical event, so no
 * elapsed real time enters the comparison and there is no boundary to straddle,
 * at any load.
 */
import { describe, it, expect } from 'vitest';
import { isProcessAlive, processStartTime, assessProcessLiveness } from '../process-liveness.js';

/** A pid high enough that no process can hold it. */
const DEAD_PID = 2147483646;
/** The process that spawned this one: alive, and never our own pid. */
const LIVE_PID = process.ppid;

/**
 * When this process started, as Node itself records it.
 *
 * `Date.now()` and `process.uptime()` are read together, so nothing elapses
 * between them: this is one instant, not a window. It is the moment `ps` is
 * being asked about, which is what makes it the right reference.
 */
function nodeStartedAt(): number {
  return Date.now() - process.uptime() * 1000;
}

/**
 * How far `ps`'s answer may sit from {@link nodeStartedAt} and still be the
 * same launch.
 *
 * One second of `lstart` quantization in whichever direction the platform
 * rounds, one for the gap between `fork`/`exec` and Node's own bootstrap, and
 * nothing for elapsed time — there is none in this comparison. Deliberately far
 * tighter than `DEFAULT_PID_REUSE_TOLERANCE_MS`, which is production's budget
 * for a wall clock that has been *stepped*; a test that adopted that window
 * would accept `Date.now()` itself as a start time for two minutes.
 *
 * The trade is stated plainly: this accepts a start time up to two seconds in
 * the FUTURE, where the old bound accepted none. That is the headroom the
 * quantization costs, and nothing realistic lands in it — `ps` is wrong about
 * a running process's start by a rounding step, not by seconds of overshoot.
 */
const PS_LSTART_SKEW_MS = 2_000;

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
  it('reports the moment this process actually started, as Node itself records it', () => {
    const startedAt = processStartTime(process.pid);
    if (startedAt === null) return; // No `ps` on this platform — the documented fallback.
    expect(startedAt.getTime()).not.toBeNaN();

    // The claim, and the only one worth making: `ps` and Node agree about when
    // this process began. That catches an epoch, an unparseable locale rendered
    // as a wrong instant, and another pid's start time — none of which the old
    // "not in the future" wording could tell apart from a correct answer.
    expect(Math.abs(startedAt.getTime() - nodeStartedAt())).toBeLessThanOrEqual(PS_LSTART_SKEW_MS);
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
