/**
 * Repeating work on a jittered beat, so a fleet of computers started together
 * (a release, a power cut, a Cloud outage ending) does not keep calling DorkOS
 * Cloud in step forever after (DOR-2086).
 *
 * Each wait is drawn fresh with **full jitter and a cap**: uniform between a
 * floor and a ceiling placed symmetrically around the period, so the average
 * wait stays the period the caller named and only the phase spreads out.
 *
 * - **Floor**, a tenth of the period: never a tight loop, however the draws fall.
 * - **Cap**, the period doubled less the floor: never much longer than twice
 *   the old fixed beat.
 *
 * Timers are `unref()`ed, so a schedule never keeps the process alive.
 *
 * @module lib/jittered-schedule
 */
import { logger } from './logger.js';

/** The timer functions a schedule uses; injectable for tests. */
export interface ScheduleTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** The share of the period that is the shortest possible wait. */
export const JITTER_FLOOR_FRACTION = 0.1;

/** A running schedule. */
export interface JitteredSchedule {
  /** Stop it. Safe to call twice; a run already started finishes on its own. */
  stop(): void;
}

/** What {@link scheduleJittered} takes beyond the task and period. */
export interface JitteredScheduleOptions {
  /** A source of uniform numbers in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number;
  /** The timer functions. Default to the global ones, `unref()`ed. */
  timers?: ScheduleTimers;
}

const DEFAULT_TIMERS: ScheduleTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One jittered wait for a beat of `periodMs`: uniform in
 * `[floor, 2 × periodMs − floor]`, so its mean is `periodMs`.
 *
 * @param periodMs - The average wait the caller wants.
 * @param random - A source of uniform numbers in `[0, 1)`; a value outside is clamped.
 * @returns The wait, in whole milliseconds, never below the floor or above the cap.
 */
export function jitteredDelay(periodMs: number, random: () => number = Math.random): number {
  const floor = Math.max(1, Math.round(periodMs * JITTER_FLOOR_FRACTION));
  const draw = Math.min(1, Math.max(0, random()));
  return Math.round(floor + draw * 2 * Math.max(0, periodMs - floor));
}

/**
 * Run `task` again and again, each time after a fresh {@link jitteredDelay}.
 * The first run is one wait away, as with `setInterval`. A task that throws is
 * logged, not retried early, and does not stop the schedule.
 *
 * @param task - The work. Not awaited: a slow run never delays the next wait.
 * @param periodMs - The average time between runs.
 * @param options - Seams for tests.
 * @returns The handle that stops it.
 */
export function scheduleJittered(
  task: () => void,
  periodMs: number,
  options: JitteredScheduleOptions = {}
): JitteredSchedule {
  const random = options.random ?? Math.random;
  const timers = options.timers ?? DEFAULT_TIMERS;
  let stopped = false;
  let handle: unknown = null;

  const arm = () => {
    if (stopped) return;
    handle = timers.setTimeout(
      () => {
        handle = null;
        if (stopped) return;
        try {
          task();
        } catch (error) {
          logger.warn('[Schedule] A scheduled run failed; the next one is still due', {
            error: error instanceof Error ? error.name : typeof error,
          });
        }
        arm();
      },
      jitteredDelay(periodMs, random)
    );
  };
  arm();

  return {
    stop() {
      stopped = true;
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
  };
}
