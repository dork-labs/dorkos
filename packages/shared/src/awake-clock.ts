/**
 * Time the computer was awake, and deadlines that count only that (DOR-3286).
 *
 * ## Why a run's deadline cannot be a plain timer
 *
 * On macOS, the clock Node's timers run on keeps counting while the computer
 * sleeps (`process.hrtime` equals wall time since boot on a Mac that has slept
 * hundreds of times). A run with a 30-minute limit that was five
 * minutes in when the lid closed has a timer that is hours overdue the moment
 * the computer wakes, so the run was stopped and recorded as having gone past
 * its time limit after five minutes of work. A scheduled fire landing in a dark
 * wake made it worse: the run started, the computer slept again seconds later,
 * and the next full wake stopped it the same way.
 *
 * ## How sleep is seen
 *
 * A sleeping process runs nothing, so a short repeating tick that comes back
 * far later than it was due says the computer slept for the difference. That
 * needs no OS hook, works the same in the desktop app and a bare server, and is
 * deterministic under an injected clock. An event loop blocked for longer than
 * {@link SLEEP_GAP_MS} reads as sleep too; a deadline then extends by the
 * stall, which is fair, since the run got nothing done while the server could
 * not serve it either.
 *
 * @module shared/awake-clock
 */

/** How often the clock checks for a gap. */
export const AWAKE_TICK_MS = 5_000;
/** A tick this much later than due is sleep, not a busy loop. */
export const SLEEP_GAP_MS = 30_000;
/** The longest delay Node honours; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Timer functions, injectable so tests run on a controlled clock. */
export interface AwakeTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

/** What {@link createAwakeClock} takes. Every field defaults to the real thing. */
export interface AwakeClockOptions {
  /** Wall-clock milliseconds. */
  now?: () => number;
  timers?: Partial<AwakeTimers>;
  /** See {@link AWAKE_TICK_MS}. */
  tickMs?: number;
}

/** Sleep seen by this process, measured from the moment it was created. */
export interface AwakeClock {
  /** Wall-clock milliseconds, from the same source the gaps are read from. */
  now(): number;
  /** Total milliseconds this process has seen the computer asleep. */
  sleptMs(): number;
  /** When the computer last woke, or null if it has not slept since start. */
  lastWakeAt(): number | null;
  /** The timers this clock runs on, for deadlines built over it. */
  readonly timers: AwakeTimers;
  /** Stop the tick. */
  dispose(): void;
}

function unref(handle: unknown): unknown {
  (handle as { unref?: () => void } | null)?.unref?.();
  return handle;
}

const REAL_TIMERS: AwakeTimers = {
  setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => unref(setInterval(fn, ms)),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Start a clock that notices sleep. Production uses {@link getAwakeClock}.
 *
 * @param options - Clock, timers and tick; real ones by default.
 */
export function createAwakeClock(options: AwakeClockOptions = {}): AwakeClock {
  const now = options.now ?? (() => Date.now());
  const timers: AwakeTimers = { ...REAL_TIMERS, ...options.timers };
  const tickMs = options.tickMs ?? AWAKE_TICK_MS;
  let lastSample = now();
  let slept = 0;
  let wokeAt: number | null = null;

  // Asked by the tick AND by every reader, so a deadline that fires on wake
  // before the tick does still sees the sleep it fired because of.
  const sample = (): void => {
    const at = now();
    const gap = at - lastSample;
    lastSample = at;
    // The whole gap counts as sleep, though up to a tick of it was awake: a
    // deadline then runs at most a tick long, never stops a run early.
    if (gap > tickMs + SLEEP_GAP_MS) {
      slept += gap;
      wokeAt = at;
    }
  };
  const tick = timers.setInterval(sample, tickMs);

  return {
    now,
    timers,
    sleptMs: () => {
      sample();
      return slept;
    },
    lastWakeAt: () => {
      sample();
      return wokeAt;
    },
    dispose: () => timers.clearInterval(tick),
  };
}

let processClock: AwakeClock | null = null;

/** The process-wide clock, started on first use. */
export function getAwakeClock(): AwakeClock {
  processClock ??= createAwakeClock();
  return processClock;
}

/**
 * Call `onExpire` once `ms` of AWAKE time has passed. Time the computer slept
 * does not count, so a run stopped by this ran for its whole limit.
 *
 * @param clock - The clock that sees sleep.
 * @param ms - The awake time allowed.
 * @param onExpire - Called once, when that time is used up.
 * @returns Cancels the deadline. Idempotent.
 */
export function awakeTimeout(clock: AwakeClock, ms: number, onExpire: () => void): () => void {
  const startedAt = clock.now();
  const sleptAtStart = clock.sleptMs();
  let handle: unknown = null;
  let done = false;
  const arm = (delay: number): void => {
    handle = clock.timers.setTimeout(check, Math.min(Math.max(delay, 0), MAX_TIMER_MS));
  };
  function check(): void {
    if (done) return;
    const awake = clock.now() - startedAt - (clock.sleptMs() - sleptAtStart);
    if (awake < ms) return arm(ms - awake);
    done = true;
    onExpire();
  }
  arm(ms);
  return () => {
    done = true;
    clock.timers.clearTimeout(handle);
  };
}

/**
 * An `AbortSignal` that aborts with a `TimeoutError` after `ms` of awake time:
 * `AbortSignal.timeout`, minus the sleep.
 *
 * @param clock - The clock that sees sleep.
 * @param ms - The awake time allowed.
 */
export function awakeTimeoutSignal(
  clock: AwakeClock,
  ms: number
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const cancel = awakeTimeout(clock, ms, () =>
    controller.abort(new DOMException('The run reached its time limit.', 'TimeoutError'))
  );
  return { signal: controller.signal, cancel };
}
