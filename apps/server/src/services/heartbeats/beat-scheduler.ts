/**
 * When each agent beats next (spec `heartbeats` §3.1, §3.2).
 *
 * Two halves:
 *
 * - {@link beatInterval}: the cadence table, first match wins, pure. Each
 *   interval gets ±10% jitter ({@link withJitter}) so forty agents do not beat
 *   in the same second.
 * - {@link BeatScheduler}: one `setTimeout` per timed agent (not croner: the
 *   interval changes every beat), on an injectable clock. Timers live in
 *   memory; the facts behind them live in `heartbeat_state`, so on startup each
 *   agent's first beat is `max(now + a 1–5 minute stagger, lastBeatAt +
 *   interval)`: a restart neither skips a beat for long nor fires a burst.
 *   {@link BeatScheduler.clearAll} is what `heartbeats.enabled = false` calls:
 *   off is really off, no timer survives it.
 *
 * @module services/heartbeats/beat-scheduler
 */

/** One minute, in ms. */
const MINUTE = 60_000;
/** One hour, in ms. */
const HOUR = 60 * MINUTE;

/** The cadence table's intervals, named so tests and prose read them from here. */
export const BEAT_INTERVALS = {
  /** Its last 3 beat turns failed (§7.5). */
  failing: 2 * HOUR,
  /** Something it owns is in flight. */
  inFlight: 10 * MINUTE,
  /** No beat found any change for a day. */
  idle: 2 * HOUR,
  /** Inside its working hours. */
  workingHours: 30 * MINUTE,
  /** Outside them. */
  offHours: 2 * HOUR,
} as const;

/** How long without a change before the beat backs off. */
export const IDLE_AFTER_MS = 24 * HOUR;

/** Beat turns failing in a row before the agent slows down (§7.5). */
export const FAILURE_STORM_AT = 3;

/** The facts the cadence table reads. */
export interface CadenceFacts {
  /** Beat turns that failed in a row. */
  consecutiveFailures: number;
  /** An asked-for pace still in force, or null. */
  pace: { everyMinutes: number; untilIso: string } | null;
  /** An open commitment due today, or a turn of its own still running. */
  inFlight: boolean;
  /** When a beat last found a change (ISO 8601), or null. */
  lastChangeAt: string | null;
  /** Whether now is inside its chain person's working hours. */
  withinHours: boolean;
}

/**
 * The next beat's interval, before jitter (spec §3.2), first match wins.
 *
 * @param facts - What the table reads.
 * @param now - Epoch ms.
 */
export function beatInterval(facts: CadenceFacts, now: number): number {
  if (facts.consecutiveFailures >= FAILURE_STORM_AT) return BEAT_INTERVALS.failing;
  if (facts.pace && Date.parse(facts.pace.untilIso) > now) {
    return facts.pace.everyMinutes * MINUTE;
  }
  if (facts.inFlight) return BEAT_INTERVALS.inFlight;
  // `lastChangeAt` is stamped at the first beat too, so a quiet day is measured
  // from when the agent started beating, not from never.
  const lastChange = facts.lastChangeAt ? Date.parse(facts.lastChangeAt) : NaN;
  if (!Number.isNaN(lastChange) && now - lastChange >= IDLE_AFTER_MS) return BEAT_INTERVALS.idle;
  return facts.withinHours ? BEAT_INTERVALS.workingHours : BEAT_INTERVALS.offHours;
}

/**
 * An interval with ±10% jitter.
 *
 * @param intervalMs - The interval.
 * @param random - A number in [0, 1); defaults to `Math.random`.
 */
export function withJitter(intervalMs: number, random: () => number = Math.random): number {
  return Math.round(intervalMs * (0.9 + 0.2 * random()));
}

/** The shortest and longest startup stagger. */
export const STARTUP_STAGGER_MS = { min: 1 * MINUTE, max: 5 * MINUTE } as const;

/**
 * When an agent's first beat after a start is due (spec §3.2).
 *
 * @param now - Epoch ms.
 * @param lastBeatAt - Its last beat (ISO 8601), or null.
 * @param intervalMs - Its current interval.
 * @param random - A number in [0, 1).
 */
export function startupBeatAt(
  now: number,
  lastBeatAt: string | null,
  intervalMs: number,
  random: () => number = Math.random
): number {
  const stagger =
    STARTUP_STAGGER_MS.min + (STARTUP_STAGGER_MS.max - STARTUP_STAGGER_MS.min) * random();
  const earliest = now + stagger;
  const last = lastBeatAt ? Date.parse(lastBeatAt) : NaN;
  return Number.isNaN(last) ? earliest : Math.max(earliest, last + intervalMs);
}

/** The clock a scheduler runs on; tests pass a fake one. */
export interface BeatClock {
  /** Epoch ms. */
  now(): number;
  /** Arm a timer. */
  setTimeout(fn: () => void, ms: number): unknown;
  /** Disarm one. */
  clearTimeout(handle: unknown): void;
}

/** The real clock. */
export const systemClock: BeatClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One armed timer. */
interface Armed {
  handle: unknown;
  at: number;
}

/**
 * One timer per timed agent. Knows nothing about beats: when a timer fires it
 * calls `onFire`, and the runner decides what that beat is and arms the next.
 */
export class BeatScheduler {
  private readonly timers = new Map<string, Armed>();

  /**
   * Build a scheduler.
   *
   * @param clock - The clock to arm timers on.
   * @param onFire - Called when an agent's timer fires.
   */
  constructor(
    private readonly clock: BeatClock,
    private readonly onFire: (agentId: string) => void
  ) {}

  /**
   * Arm (or re-arm) an agent's next beat at a moment.
   *
   * @param agentId - The agent.
   * @param at - Epoch ms.
   */
  armAt(agentId: string, at: number): void {
    this.cancel(agentId);
    const delay = Math.max(0, at - this.clock.now());
    const handle = this.clock.setTimeout(() => {
      // Only the timer still armed for this agent fires; a re-arm replaced it.
      if (this.timers.get(agentId)?.handle !== handle) return;
      this.timers.delete(agentId);
      this.onFire(agentId);
    }, delay);
    this.timers.set(agentId, { handle, at });
  }

  /**
   * Disarm an agent's timer.
   *
   * @param agentId - The agent.
   */
  cancel(agentId: string): void {
    const armed = this.timers.get(agentId);
    if (!armed) return;
    this.clock.clearTimeout(armed.handle);
    this.timers.delete(agentId);
  }

  /** Disarm every timer: what turning heartbeats off does. */
  clearAll(): void {
    for (const armed of this.timers.values()) this.clock.clearTimeout(armed.handle);
    this.timers.clear();
  }

  /**
   * When an agent's next timed beat is due, or null when none is armed.
   *
   * @param agentId - The agent.
   */
  nextAt(agentId: string): number | null {
    return this.timers.get(agentId)?.at ?? null;
  }

  /** How many timers are armed. */
  get size(): number {
    return this.timers.size;
  }
}
