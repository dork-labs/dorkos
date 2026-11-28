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
 *
 * **The first turn itself** starts through the turn port (spec
 * `turns-survive-restarts` §3, T6): `session_start` hands its first message to
 * the space face here ({@link startSpinOffTurn}) and hears at once what became
 * of it, and this follows the run until its turn is over. A spin-off that
 * finds every launch slot under `runtimes.maxAgentChats` taken waits for one
 * (`machine_full`), with its place, instead of being refused; while it waits
 * the deadline is held a beat at a time, as a wait for a warm slot holds it.
 * Chat messaging is space side (`contributing/architecture-target.md` §3), so
 * the tool, which is turn code, reaches the port through here; startup hands
 * the port in ({@link setSpinOffTurnPort}).
 */
import { MAX_START_WAIT_MS } from '@dorkos/shared/run-time-limit';
import type { RunStatus, StartTurnInput } from '@dorkos/shared/turn-port';
import type { HandOverNowAnswer } from '@dorkos/shared/turn-hand-over';
import type { SpaceTurnPort, TurnRun } from '../../../runs/index.js';
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

/** The turn port's parts a spin-off's first turn uses, as startup hands them in. */
export interface SpinOffTurnPort {
  /** Save a run and hand it over now (`handOverTurn` in `services/runs`). */
  handOver: (
    input: StartTurnInput,
    opts: { runId: string }
  ) => Promise<HandOverNowAnswer> | undefined;
  /** The space face, for following the run; `undefined` before startup wired it. */
  port: () => Pick<SpaceTurnPort, 'watch' | 'get'> | undefined;
}

let spinOffPort: SpinOffTurnPort | undefined;

/**
 * Hand in the turn port at startup, or clear it.
 *
 * @param port - The hand-over and the space face.
 */
export function setSpinOffTurnPort(port: SpinOffTurnPort | undefined): void {
  spinOffPort = port;
}

/** How often a waiting spin-off holds its first-turn deadline: inside the startup's lease. */
export const SPIN_OFF_WAIT_BEAT_MS = 60_000;

/** A run's statuses once its turn is over or never comes. */
const OVER: ReadonlySet<RunStatus> = new Set(['ended', 'settled', 'cancelled', 'superseded']);

/** How a spin-off's first turn settled, as `session_start` reads it. */
export type SpinOffSettled = (outcome: 'ok' | 'failed', refusal?: string) => void;

/** How a run's turn settled: a refusal carries the runtime's words; a stop is not a failure. */
function settledAs(run: TurnRun): [outcome: 'ok' | 'failed', refusal?: string] {
  if (run.status === 'superseded') return ['ok'];
  if (run.status === 'cancelled') {
    return ['failed', `It did not start (${run.endingDetail.cancelledBecause ?? 'cancelled'}).`];
  }
  if (run.ending === 'refused') {
    return ['failed', run.endingDetail.refusal ?? 'The runtime refused the turn.'];
  }
  return run.ending === 'completed' || run.ending === 'stopped' ? ['ok'] : ['failed'];
}

/**
 * Start a spin-off's first turn through the port and follow it.
 *
 * @param input - The turn, as the space face's `start()` takes it.
 * @param opts.runId - The run's id: the first message's id, which its chat message names.
 * @param opts.onSettled - Called once, when the turn is over or will never come.
 * @returns What became of the hand-over, or `undefined` before startup wired the port.
 * @throws What the launch path threw, after the run was cancelled.
 */
export async function startSpinOffTurn(
  input: StartTurnInput,
  opts: { runId: string; onSettled: SpinOffSettled }
): Promise<HandOverNowAnswer | undefined> {
  const port = spinOffPort?.port();
  if (!port || !spinOffPort) return undefined;
  const { handOver } = spinOffPort;
  let beat: ReturnType<typeof setInterval> | undefined;
  let over = false;
  // The chat as the run is kept under now: a rebind moves it to the runtime's id.
  let chat = input.sessionId;
  const stopBeating = (): void => {
    if (beat === undefined) return;
    clearInterval(beat);
    beat = undefined;
    getSpinOffStartup()?.doneWaiting(chat);
  };
  const hear = (run: TurnRun): void => {
    if (over) return;
    chat = run.sessionId;
    if (run.status === 'queued' && run.waitReason !== null) {
      // Waiting in line holds the first-turn deadline, beat by beat.
      getSpinOffStartup()?.waitingToStart(chat);
      beat ??= setInterval(() => getSpinOffStartup()?.waitingToStart(chat), SPIN_OFF_WAIT_BEAT_MS);
      beat.unref?.();
    } else {
      stopBeating();
    }
    if (!OVER.has(run.status)) return;
    over = true;
    unwatch();
    opts.onSettled(...settledAs(run));
  };
  // Heard from the first write on: the hand-over below can start the turn.
  const unwatch = port.watch(hear, { runId: opts.runId });
  let answer: HandOverNowAnswer | undefined;
  try {
    answer = await handOver(input, { runId: opts.runId });
  } catch (err) {
    over = true;
    unwatch();
    stopBeating();
    throw err;
  }
  if (!answer || answer.kind === 'refused') {
    // A refusal is the caller's to report; it leaves no turn to follow.
    over = true;
    unwatch();
    stopBeating();
    return answer;
  }
  const now = port.get(opts.runId);
  if (now) hear(now);
  return answer;
}
