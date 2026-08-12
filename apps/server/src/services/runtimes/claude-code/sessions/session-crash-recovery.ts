/**
 * What happens after one session's process dies, and how many times the server
 * is willing to try again (spec `persistent-session-runtime` §4.2, task 3.6).
 *
 * With resume-per-message a crash cost one turn and the next message trivially
 * restarted. With a pump the blast radius is the SESSION: the warm process, the
 * in-flight turn, and every message queued behind it. This module is where the
 * spec's promise about that is kept — and it is a small module on purpose,
 * because two of the three things a crash must do are already somebody's job:
 *
 * | What a crash must do                        | Who does it                                    |
 * | ------------------------------------------- | ---------------------------------------------- |
 * | close the open turn as a failure            | `session-turn-windows.ts` (task 3.3)           |
 * | relaunch with `resume` on the next dispatch | `SessionPump.dispatch` on a CRASHED pump       |
 * | decide WHETHER to relaunch, and record why  | here                                           |
 *
 * So this sits on the pump's `onCrash` seam, forwards to the windower, and owns
 * the one decision neither of them can make: is the next dispatch a recovery,
 * or a session that is broken and needs to say so.
 *
 * ## The queue is not touched, by anybody, ever
 *
 * There is deliberately no queue code in this file, and that absence IS the
 * design. The durable queue (`message-queue-store.ts`) retires a row on
 * correlated OUTPUT evidence — the `turn_start` the projector ingests — and on
 * nothing else. A crash produces no `turn_start`, so every row that had not
 * already started a turn is still there afterwards, in order, under the ids it
 * was accepted with. The in-flight turn's own row is already gone, retired when
 * that turn started, which is exactly the spec's crash-table row: `RUNNING →
 * CRASHED`, **queue preserved**. Recovery therefore needs no queue restore, and
 * a restore written here would be the bug: it would resurrect a message the
 * person already watched run.
 *
 * ## The bound: one automatic resume per crash
 *
 * A crash arms ONE automatic relaunch. If the relaunched process crashes again
 * with no completed turn in between, the next dispatch is REFUSED with a
 * {@link SessionCrashLoopError} rather than booting a third process, so a
 * genuinely broken session surfaces to the person instead of spinning
 * subprocesses on its own.
 *
 * Two rules make that bound behave:
 *
 * - **Only a COMPLETED TURN resets it** ({@link SessionCrashRecovery.noteStateChange},
 *   on `RUNNING → WARM`). Reaching `system/init` deliberately does not: the
 *   failure this bounds is a process that boots perfectly and dies mid-turn, so
 *   treating a successful boot as recovery would disarm the bound against the
 *   exact case it exists for.
 * - **A refusal is a message to a person, not a brick.** Refusing spends the
 *   run back down to one, so the person's next attempt gets a launch and, if it
 *   fails the same way, is refused again. The steady state of a permanently
 *   broken session is therefore one process per two dispatches, every failure
 *   visible — never a server-driven loop, and never a session nothing can
 *   revive short of a restart.
 *
 * ## Where an idle crash is visible
 *
 * A crash with no turn open gets no stream event, on purpose: the session
 * stream's `error` member is a TURN error — it rides inside a turn and drives
 * `SessionStatus.lastError` — and minting a turn for a session where nothing
 * was running would report a failure that never happened. An idle crash is
 * visible where it actually is: `getSessionWarmth` answers `'crashed'` (task
 * 3.10 pins that in the conformance suite), a warning names it in the log, and
 * {@link SessionCrashRecovery.lastCrash} carries the account for anything that
 * wants to show it.
 *
 * @module services/runtimes/claude-code/sessions/session-crash-recovery
 */
import { logger } from '../../../../lib/logger.js';
import type { PumpCrash, PumpDispatch, PumpState } from './session-pump-contract.js';
import type { TurnWindow } from './session-turn-windows.js';

/**
 * How many relaunches one crash buys before the next dispatch has to be
 * refused. One, per the spec: enough that the overwhelming case — a process
 * that died once — recovers without anyone noticing, and few enough that a
 * session which cannot stay up says so.
 */
export const AUTOMATIC_RESUMES_PER_CRASH = 1;

/** One process death, as the operator would want it described. */
export interface CrashRecord {
  sessionId: string;
  /** When it was observed, in epoch milliseconds. */
  at: number;
  /** What the pump was doing. `running` means a turn was open. */
  stateAtCrash: PumpState;
  /** What ended the process, in plain words. */
  message: string;
  /** Crashes in a row with no completed turn between them, counting this one. */
  consecutive: number;
  /** Whether the next dispatch will relaunch rather than be refused. */
  willAutoResume: boolean;
}

/**
 * The session's process keeps dying, so this dispatch was refused instead of
 * booting another one.
 *
 * A caller surfaces it as a turn error and leaves the durable queue alone: the
 * message did not run, so its row belongs exactly where it is.
 */
export class SessionCrashLoopError extends Error {
  /**
   * Report a refused relaunch.
   *
   * @param sessionId - The session whose process keeps dying
   * @param crash - The crash that spent the session's last automatic resume
   */
  constructor(
    readonly sessionId: string,
    readonly crash: CrashRecord | undefined
  ) {
    super(
      `session ${sessionId} crashed again right after it was restarted, so it was not restarted a second time${
        crash === undefined ? '' : `: ${crash.message}`
      }`
    );
    this.name = 'SessionCrashLoopError';
  }
}

/** The slice of `SessionPump` this reads. `SessionPump` satisfies it. */
export interface CrashRecoveryPump {
  /** Where the machine is; `crashed` is what makes a dispatch a recovery. */
  readonly state: PumpState;
}

/** The slice of `SessionTurnWindows` this drives. `SessionTurnWindows` satisfies it. */
export interface CrashRecoveryWindows {
  /** Close whatever window was open as a failure. */
  onCrash(crash: PumpCrash): void;
  /** Open a window for one dequeued batch, in `cwd`, and dispatch it. */
  dispatch(batch: readonly PumpDispatch[], cwd: string): Promise<TurnWindow>;
}

/** Everything the recovery needs to own one session's failover. */
export interface SessionCrashRecoveryOptions {
  sessionId: string;
  /** The pump whose process may die. */
  pump: CrashRecoveryPump;
  /** The windower the crash is forwarded to, and dispatches go through. */
  windows: CrashRecoveryWindows;
  /** Every crash, recorded — for anything that wants to show or count them. */
  onCrashRecorded?: (record: CrashRecord) => void;
  /** Clock seam, so a test can pin `at` without waiting for one. */
  now?: () => number;
}

/** What the stream threw, in words a person can read. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === undefined) return 'the process ended without saying why';
  return String(error);
}

/**
 * One session's crash policy: the failover seam, and the bound on it.
 *
 * Wire {@link handleCrash} to the pump's `onCrash` and {@link noteStateChange}
 * to its `onStateChange`, then dispatch through {@link dispatch} rather than
 * through the windower, so every turn passes the bound on its way to a process.
 */
export class SessionCrashRecovery {
  private readonly opts: SessionCrashRecoveryOptions;
  /** Crashes in a row with no completed turn between them. */
  private run = 0;
  private latest: CrashRecord | undefined;

  /**
   * Build the recovery for one session.
   *
   * @param opts - The pump, the windower, and the recording seam
   */
  constructor(opts: SessionCrashRecoveryOptions) {
    this.opts = opts;
  }

  /** The most recent crash, or `undefined` while this session has had none. */
  get lastCrash(): CrashRecord | undefined {
    return this.latest;
  }

  /** Crashes in a row with no completed turn between them. Zero when healthy. */
  get consecutiveCrashes(): number {
    return this.run;
  }

  /** Would the next dispatch relaunch, or be refused? */
  get willAutoResume(): boolean {
    return this.run <= AUTOMATIC_RESUMES_PER_CRASH;
  }

  /**
   * The pump's `onCrash` seam: record the death, then close whatever window was
   * open as a failure.
   *
   * Recording FIRST is deliberate. Closing the window projects a `turn_end`,
   * and anything watching that boundary can dispatch the next queued message in
   * the same beat — so the bound has to be up to date before the window closes,
   * or the message behind a second consecutive crash would be let through on
   * the count from the first.
   *
   * @param crash - What the pump observed
   */
  handleCrash(crash: PumpCrash): void {
    this.run += 1;
    const record: CrashRecord = {
      sessionId: crash.sessionId,
      at: (this.opts.now ?? Date.now)(),
      stateAtCrash: crash.stateAtCrash,
      message: describe(crash.error),
      consecutive: this.run,
      willAutoResume: this.willAutoResume,
    };
    this.latest = record;
    logger.warn('[SessionCrashRecovery] a session lost its process', {
      sessionId: record.sessionId,
      stateAtCrash: record.stateAtCrash,
      consecutive: record.consecutive,
      willAutoResume: record.willAutoResume,
      error: record.message,
    });
    this.announce(record);
    this.opts.windows.onCrash(crash);
  }

  /**
   * The pump's `onStateChange` seam: a turn that COMPLETED is the only evidence
   * this session is healthy again, so it is the only thing that clears the run.
   *
   * `RUNNING → WARM` is that evidence and nothing else is: the pump takes that
   * edge from `endTurn`, which the windower calls once a window's `result` has
   * been released. A crash leaves `running` for `crashed` instead, so it can
   * never be mistaken for one.
   *
   * @param change - The transition the pump just took
   */
  noteStateChange(change: { from: PumpState; to: PumpState }): void {
    if (change.from !== 'running' || change.to !== 'warm') return;
    this.run = 0;
  }

  /**
   * Dispatch one dequeued batch, resuming a crashed session at most once.
   *
   * On a healthy session this is a pass-through to the windower. On a CRASHED
   * one it is the failover: the pump relaunches with `resume` set from inside
   * `dispatch`, which is today's path exactly — F1's anchoring and F2's
   * stale-session retry included, both deliberately retained because THIS is
   * the route they are kept for.
   *
   * The working directory is carried through rather than remembered, because
   * the windower asks the boundary about it on every dispatch (task 3.9) — a
   * relaunch after a crash is a new process in whatever directory the session
   * names TODAY, and it is gated exactly like any other turn.
   *
   * @param batch - The messages dequeued together, to run as one turn
   * @param cwd - The working directory this turn would run in
   * @returns The window this dispatch opened
   * @throws SessionCrashLoopError When this session has already spent its
   *   automatic resume on a process that crashed straight back
   */
  async dispatch(batch: readonly PumpDispatch[], cwd: string): Promise<TurnWindow> {
    if (this.opts.pump.state === 'crashed' && !this.willAutoResume) {
      // Spent back down to a single crash, not to zero: the person has been
      // told, so their next attempt gets a launch — and if it dies the same
      // way, the attempt after it is refused again.
      this.run = AUTOMATIC_RESUMES_PER_CRASH;
      logger.warn('[SessionCrashRecovery] refused to restart a session that keeps crashing', {
        sessionId: this.opts.sessionId,
        messageIds: batch.map((message) => message.messageId),
      });
      throw new SessionCrashLoopError(this.opts.sessionId, this.latest);
    }
    return this.opts.windows.dispatch(batch, cwd);
  }

  /** Tell the recorder, without letting its failure reach the read loop. */
  private announce(record: CrashRecord): void {
    try {
      this.opts.onCrashRecorded?.(record);
    } catch (err) {
      logger.warn('[SessionCrashRecovery] a crash recorder threw', {
        sessionId: this.opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
