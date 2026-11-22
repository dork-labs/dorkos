/**
 * First-turn deadlines for session_start. Reporting stays with ChatReportBack.
 * Entries follow canonical IDs and disappear on agent output or chat removal.
 * Like report-back retries, pending deadlines and failed-start status live in this process.
 *
 * The deadline does not count a turn's wait in line for a free agent slot on
 * this computer (DOR-4985: spin-offs that waited 5 to 11 minutes for a slot
 * were reported "never started", and their starters retried them). The wait
 * is a lease, not a switch: each beat of it holds the clock for
 * {@link WAIT_LEASE_MS}, so a stream that goes silent mid-wait starts counting
 * again from its last beat, and no wait holds it past {@link MAX_START_WAIT_MS}.
 * A start that comes after a failure was sent tells the same parent once that
 * it started after all, and never ahead of the failure itself.
 */
import { MAX_START_WAIT_MS } from '@dorkos/shared/run-time-limit';
import { NO_MARKS, type TurnMarks } from '../../../core/turn-power/turn-marks.js';
import { logger, logError } from '../../../../lib/logger.js';

/** A spin-off must open its first turn within five minutes. */
export const SPIN_OFF_START_TIMEOUT_MS = 5 * 60_000;

/**
 * How long one slot-wait beat holds the clock. The runtime repeats the beat
 * every minute while it waits (`SLOT_WAIT_BEAT_MS`), so two missed beats mean
 * the wait is no longer being reported, and the time since the last one counts.
 */
export const WAIT_LEASE_MS = 2 * 60_000;

/** The clock and timers the deadline runs on; the real ones unless a test hands its own. */
export interface StartupClock {
  /** The time now, in milliseconds. */
  now(): number;
  /** Run `run` after about `ms`; it may fire early, and the deadline checks {@link now}. */
  set(run: () => void, ms: number): ReturnType<typeof setTimeout>;
  /** Cancel a timer {@link set} returned. */
  clear(handle: ReturnType<typeof setTimeout>): void;
}

const REAL_CLOCK: StartupClock = {
  now: () => Date.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle),
};

/** What the existing report-back path supplies. */
export interface SpinOffStartupDeps {
  failureReason(sessionId: string, fallback?: string): string;
  report(sessionId: string, reason: string, marks: TurnMarks): Promise<void>;
  /** Tell the parent a chat already reported as never started has started. */
  reportStartedLate?(sessionId: string, marks: TurnMarks): Promise<void>;
  /** The clock the deadline runs on; the real one by default. */
  clock?: StartupClock;
}

interface Startup {
  timer?: ReturnType<typeof setTimeout>;
  sessionId: string;
  marks: TurnMarks;
  agentPath?: string;
  reason?: string;
  failure?: string;
  /** Time already counted toward the deadline, before the current stretch. */
  countedMs: number;
  /** When the current counted stretch began; absent while the turn waits for a slot. */
  countingSince?: number;
  /** When the current slot wait began, while it lasts. */
  waitingSince?: number;
  /** The latest beat of the current slot wait. */
  lastBeat?: number;
  /** The never-started report on its way, so a late start's correction goes after it. */
  reported?: Promise<void>;
}

/** Tracks starts, not later pauses or idle periods in an established chat. */
export class SpinOffStartup {
  private readonly starts = new Map<string, Startup>();
  private readonly clock: StartupClock;

  /** Use the existing report sender and its startup diagnostics. */
  constructor(private readonly deps: SpinOffStartupDeps) {
    this.clock = deps.clock ?? REAL_CLOCK;
  }

  /** Arm before awaiting launch, so a launch promise that hangs is covered too. */
  watch(sessionId: string, agentPath?: string, marks: TurnMarks = NO_MARKS): void {
    if (this.starts.has(sessionId)) return;
    const entry: Startup = {
      sessionId,
      marks: structuredClone(marks),
      agentPath,
      countedMs: 0,
      countingSince: this.clock.now(),
    };
    this.starts.set(sessionId, entry);
    this.arm(entry, SPIN_OFF_START_TIMEOUT_MS);
  }

  /**
   * Agent output proves a start; a synthetic projector turn alone does not. A
   * start after a failure was sent tells the parent once, then the chat reads
   * as whatever its turn shows.
   */
  started(sessionId: string): void {
    const entry = this.starts.get(sessionId);
    this.forget(sessionId);
    const reportLate = this.deps.reportStartedLate;
    if (!entry?.failure || !reportLate) return;
    // After the failure's own delivery and retries, so the parent never reads
    // "started after all" and then "never started".
    void (entry.reported ?? Promise.resolve())
      .then(() => reportLate(entry.sessionId, entry.marks))
      .catch((err: unknown) => {
        logger.warn('[chat report-back] a late start could not be reported', {
          sessionId: entry.sessionId,
          ...logError(err),
        });
      });
  }

  /**
   * One beat of the turn waiting in line for a free agent slot: hold the clock
   * for {@link WAIT_LEASE_MS} more. The runtime has not been asked to start
   * yet, so the wait is not its failure.
   */
  waitingToStart(sessionId: string): void {
    const entry = this.starts.get(sessionId);
    if (!entry || entry.failure) return;
    const now = this.clock.now();
    if (entry.countingSince !== undefined) {
      entry.countedMs += now - entry.countingSince;
      entry.countingSince = undefined;
      entry.waitingSince = now;
    }
    if (entry.waitingSince === undefined) return;
    entry.lastBeat = now;
    const leaseEnds = now + WAIT_LEASE_MS;
    const capEnds = entry.waitingSince + MAX_START_WAIT_MS;
    this.arm(entry, Math.min(leaseEnds, capEnds) - now);
  }

  /** The slot wait is over: give the runtime what is left of its five minutes. */
  doneWaiting(sessionId: string): void {
    const entry = this.starts.get(sessionId);
    if (entry) this.resume(entry, this.clock.now());
  }

  /** A refused launch is already reported to its caller and leaves no spin-off. */
  forget(sessionId: string): void {
    const entry = this.starts.get(sessionId);
    if (entry) this.disarm(entry);
    this.starts.delete(sessionId);
  }

  /** Keep a launch-time diagnostic until the deadline, without restarting its clock. */
  noteFailure(sessionId: string, reason: string): void {
    const entry = this.starts.get(sessionId);
    if (entry) entry.reason = reason;
  }

  /** Follow a canonical rename without giving the start another five minutes. */
  rekey(from: string, to: string): void {
    if (from === to) return;
    const entry = this.starts.get(from);
    if (!entry) return;
    this.starts.delete(from);
    entry.sessionId = to;
    this.starts.set(to, entry);
  }

  /** Whether this spin-off still has no evidence that its first turn ran. */
  isWatching(sessionId: string): boolean {
    return this.starts.has(sessionId);
  }

  /** The reason a timed-out startup reads never-started, or null. */
  failureOf(sessionId: string): string | null {
    return this.starts.get(sessionId)?.failure ?? null;
  }

  /** The known sender home, even when launch stopped before the runtime bound it. */
  agentPathOf(sessionId: string): string | null {
    return this.starts.get(sessionId)?.agentPath ?? null;
  }

  /** Drop timers when the owning server service shuts down. */
  stop(): void {
    for (const entry of this.starts.values()) this.disarm(entry);
    this.starts.clear();
  }

  /** Start counting again from `from`, and set the timer for what is still owed. */
  private resume(entry: Startup, from: number): void {
    if (entry.failure || entry.countingSince !== undefined) return;
    entry.countingSince = from;
    entry.waitingSince = undefined;
    entry.lastBeat = undefined;
    this.arm(entry, SPIN_OFF_START_TIMEOUT_MS - entry.countedMs - (this.clock.now() - from));
  }

  /** Set the deadline timer for the time still owed. */
  private arm(entry: Startup, ms: number): void {
    this.disarm(entry);
    entry.timer = this.clock.set(() => this.expire(entry), Math.max(0, ms));
    entry.timer.unref?.();
  }

  /** Cancel the deadline timer, if one is set. */
  private disarm(entry: Startup): void {
    if (entry.timer !== undefined) this.clock.clear(entry.timer);
    entry.timer = undefined;
  }

  /**
   * Record the failure once, then use report-back's existing delivery retries.
   * The clock, not the timer, decides: a timer that fires before the counted
   * time reaches the deadline is set again for the rest.
   */
  private expire(entry: Startup): void {
    const { sessionId } = entry;
    entry.timer = undefined;
    if (this.starts.get(sessionId) !== entry || entry.failure) return;
    if (entry.countingSince === undefined) {
      // A wait whose beats stopped counts again from its last beat; one past
      // the longest real wait counts again from now.
      const now = this.clock.now();
      const capEnds = (entry.waitingSince ?? now) + MAX_START_WAIT_MS;
      const leaseEnds = (entry.lastBeat ?? now) + WAIT_LEASE_MS;
      if (now >= capEnds) return this.resume(entry, now);
      if (now >= leaseEnds) return this.resume(entry, entry.lastBeat ?? now);
      return this.arm(entry, Math.min(leaseEnds, capEnds) - now);
    }
    const counted = entry.countedMs + (this.clock.now() - entry.countingSince);
    if (counted < SPIN_OFF_START_TIMEOUT_MS) {
      this.arm(entry, SPIN_OFF_START_TIMEOUT_MS - counted);
      return;
    }
    let reason = entry.reason ?? 'The runtime did not start its first turn within five minutes.';
    try {
      reason = this.deps.failureReason(sessionId, entry.reason);
    } catch (err) {
      logger.warn('[chat report-back] could not read the startup diagnostic', {
        sessionId,
        ...logError(err),
      });
    }
    entry.failure = reason;
    entry.reported = Promise.resolve()
      .then(() => this.deps.report(sessionId, reason, entry.marks))
      .catch((err: unknown) => {
        logger.warn('[chat report-back] a startup failure could not be reported', {
          sessionId,
          ...logError(err),
        });
      });
  }
}

let current: SpinOffStartup | undefined;

/** Wire the deadline service with report-back, or clear it at shutdown. */
export function setSpinOffStartup(startup: SpinOffStartup | undefined): void {
  current = startup;
}

/** The startup service, absent before chat messaging boots. */
export function getSpinOffStartup(): SpinOffStartup | undefined {
  return current;
}
