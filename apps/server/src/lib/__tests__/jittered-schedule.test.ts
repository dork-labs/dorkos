/**
 * The jittered beat (DOR-2086): every wait between a floor and a cap, the
 * average the period the caller named, never a tight loop, and a stop that
 * holds.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  JITTER_FLOOR_FRACTION,
  jitteredDelay,
  scheduleJittered,
  type ScheduleTimers,
} from '../jittered-schedule.js';

/** Timers that run only when the test says, recording each wait. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number; handle: number }> = [];
  const waits: number[] = [];
  let next = 0;
  const timers: ScheduleTimers = {
    setTimeout: (fn, ms) => {
      waits.push(ms);
      const handle = ++next;
      pending.push({ fn, ms, handle });
      return handle;
    },
    clearTimeout: (handle) => {
      const index = pending.findIndex((entry) => entry.handle === handle);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  return {
    timers,
    waits,
    pending,
    fire: () => pending.shift()?.fn(),
  };
}

describe('jitteredDelay', () => {
  const periods = [30_000, 60_000, 15 * 60_000, 60 * 60_000];

  it.each(periods)('stays between the floor and the cap for a %i ms beat', (period) => {
    const floor = period * JITTER_FLOOR_FRACTION;
    expect(jitteredDelay(period, () => 0)).toBe(floor);
    expect(jitteredDelay(period, () => 0.999999)).toBeLessThanOrEqual(2 * period - floor);
    expect(jitteredDelay(period, () => 0.5)).toBe(period);
    // A broken source cannot push it out of range either way.
    expect(jitteredDelay(period, () => -3)).toBe(floor);
    expect(jitteredDelay(period, () => 7)).toBe(2 * period - floor);
  });

  it('averages the period over many draws, so the beat keeps its old rate', () => {
    let seed = 42;
    const random = () => {
      // A small deterministic LCG: the test never depends on Math.random.
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const period = 60_000;
    const draws = Array.from({ length: 20_000 }, () => jitteredDelay(period, random));
    const mean = draws.reduce((sum, ms) => sum + ms, 0) / draws.length;
    expect(Math.abs(mean - period) / period).toBeLessThan(0.02);
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(period * JITTER_FLOOR_FRACTION);
    expect(Math.max(...draws)).toBeLessThanOrEqual(2 * period);
  });

  it('never returns a zero wait, even for a tiny period', () => {
    expect(jitteredDelay(1, () => 0)).toBeGreaterThanOrEqual(1);
    expect(jitteredDelay(5, () => 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('scheduleJittered', () => {
  it('waits a fresh jittered delay before every run', () => {
    const t = manualTimers();
    const draws = [0, 1, 0.5];
    const task = vi.fn();
    scheduleJittered(task, 10_000, { random: () => draws.shift() ?? 0.5, timers: t.timers });
    expect(task).not.toHaveBeenCalled();
    t.fire();
    t.fire();
    t.fire();
    expect(task).toHaveBeenCalledTimes(3);
    expect(t.waits.slice(0, 3)).toEqual([1_000, 19_000, 10_000]);
    expect(t.waits.every((ms) => ms >= 1_000)).toBe(true);
  });

  it('keeps its beat when a run throws', () => {
    const t = manualTimers();
    const task = vi.fn(() => {
      throw new Error('one bad run');
    });
    scheduleJittered(task, 1_000, { random: () => 0.5, timers: t.timers });
    expect(() => t.fire()).not.toThrow();
    expect(t.pending).toHaveLength(1);
    t.fire();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('stops for good', () => {
    const t = manualTimers();
    const task = vi.fn();
    const schedule = scheduleJittered(task, 1_000, { random: () => 0.5, timers: t.timers });
    schedule.stop();
    schedule.stop();
    expect(t.pending).toHaveLength(0);
    expect(task).not.toHaveBeenCalled();
  });

  it('runs on the real timers until stopped', () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn();
      const schedule = scheduleJittered(task, 1_000, { random: () => 0.5 });
      vi.advanceTimersByTime(1_000);
      expect(task).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_000);
      expect(task).toHaveBeenCalledTimes(2);
      schedule.stop();
      vi.advanceTimersByTime(10_000);
      expect(task).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
