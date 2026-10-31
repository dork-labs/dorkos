/**
 * A deadline counts only the time the computer was awake (DOR-3286). Runs on a
 * hand-driven clock: `sleep` moves time on without running anything, then lets
 * every overdue timer fire once, which is what a Mac waking up does to Node.
 */
import { describe, expect, it } from 'vitest';
import {
  AWAKE_TICK_MS,
  awakeTimeout,
  awakeTimeoutSignal,
  createAwakeClock,
  type AwakeTimers,
} from '../awake-clock.js';

interface Timer {
  at: number;
  fn: () => void;
  every: number | null;
}

/** A clock and timers a test drives by hand. */
function handClock() {
  let now = 1_000_000;
  const timers = new Set<Timer>();
  const add = (fn: () => void, ms: number, every: number | null): Timer => {
    const timer = { at: now + ms, fn, every };
    timers.add(timer);
    return timer;
  };
  const fake: AwakeTimers = {
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: (t) => void timers.delete(t as Timer),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: (t) => void timers.delete(t as Timer),
  };
  /** Fire whatever is due, earliest first, once each. */
  const fireDue = (): void => {
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > now || !timers.has(timer)) continue;
      if (timer.every === null) timers.delete(timer);
      else timer.at = now + timer.every;
      timer.fn();
    }
  };
  return {
    now: () => now,
    timers: fake,
    /** Awake time passing: every timer fires on time, to within `step`. */
    advance(ms: number, step = 1_000): void {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + step);
        fireDue();
      }
    },
    /** The computer asleep: nothing runs, then everything overdue fires. */
    sleep(ms: number): void {
      now += ms;
      fireDue();
    },
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('awake clock', () => {
  it('sees a sleep as the gap a late tick leaves', () => {
    const hand = handClock();
    const clock = createAwakeClock({ now: hand.now, timers: hand.timers });

    hand.advance(10 * MIN);
    expect(clock.sleptMs()).toBe(0);
    expect(clock.lastWakeAt()).toBeNull();

    hand.sleep(8 * HOUR);
    expect(clock.sleptMs()).toBeGreaterThanOrEqual(8 * HOUR);
    expect(clock.sleptMs()).toBeLessThanOrEqual(8 * HOUR + AWAKE_TICK_MS);
    expect(clock.lastWakeAt()).toBe(hand.now());
  });

  it('does not call a busy few seconds sleep', () => {
    const hand = handClock();
    const clock = createAwakeClock({ now: hand.now, timers: hand.timers });
    hand.sleep(20_000);
    expect(clock.sleptMs()).toBe(0);
  });
});

describe('awakeTimeout', () => {
  it('does not stop a run the moment the computer wakes from a long sleep', () => {
    const hand = handClock();
    const clock = createAwakeClock({ now: hand.now, timers: hand.timers });
    let expired = false;
    awakeTimeout(clock, 30 * MIN, () => (expired = true));

    hand.advance(5 * MIN);
    hand.sleep(8 * HOUR);
    expect(expired).toBe(false);

    hand.advance(24 * MIN);
    expect(expired).toBe(false);
    hand.advance(2 * MIN);
    expect(expired).toBe(true);
  });

  it('stops a run that was awake for its whole limit, once', () => {
    const hand = handClock();
    const clock = createAwakeClock({ now: hand.now, timers: hand.timers });
    let calls = 0;
    awakeTimeout(clock, 30 * MIN, () => (calls += 1));
    hand.advance(30 * MIN);
    expect(calls).toBe(1);
    hand.advance(60 * MIN);
    expect(calls).toBe(1);
  });

  it('notices the sleep even when the deadline fires before the tick does', () => {
    const hand = handClock();
    // A tick far apart, so on wake the deadline is the first timer to run.
    const clock = createAwakeClock({ now: hand.now, timers: hand.timers, tickMs: 10 * MIN });
    let expired = false;
    awakeTimeout(clock, 2 * MIN, () => (expired = true));
    hand.advance(1 * MIN);
    hand.sleep(3 * HOUR);
    expect(expired).toBe(false);
  });

  it('holds a limit longer than a single Node timer can', () => {
    const hand = handClock();
    const clock = createAwakeClock({ now: hand.now, timers: hand.timers, tickMs: HOUR });
    let expired = false;
    // 30 days: past the 2^31-1 ms a bare timer fires at once for.
    awakeTimeout(clock, 30 * 24 * HOUR, () => (expired = true));
    hand.advance(29 * 24 * HOUR, 30 * MIN);
    expect(expired).toBe(false);
    hand.advance(2 * 24 * HOUR, 30 * MIN);
    expect(expired).toBe(true);
  });

  it('cancels', () => {
    const hand = handClock();
    const clock = createAwakeClock({ now: hand.now, timers: hand.timers });
    let expired = false;
    const cancel = awakeTimeout(clock, MIN, () => (expired = true));
    cancel();
    hand.advance(5 * MIN);
    expect(expired).toBe(false);
  });

  it('aborts its signal with a TimeoutError, the name the run row reads', () => {
    const hand = handClock();
    const clock = createAwakeClock({ now: hand.now, timers: hand.timers });
    const { signal } = awakeTimeoutSignal(clock, MIN);
    hand.advance(MIN);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as { name?: string }).name).toBe('TimeoutError');
  });
});
