/**
 * What a turn does with the CLI's stdin at a `result` (DOR-1149, re-scoped by
 * DOR-1238) — the acting half of the question `turn-liveness.ts` answers.
 *
 * Two things live here. {@link settleStdinAtResult} applies the decision: close
 * when the turn is over, hold when it is not. And {@link createDeferredClose}
 * is the wall-clock bound on ONE kind of hold — a settled notification still
 * owed a delivery, with no background agent live, which is the only wait
 * nothing else bounds. A hold for a live agent is bounded by the SDK's own
 * level signal and must NOT be given a deadline: expiring one mid-segment is
 * precisely the failure DOR-1238 fixed.
 *
 * The send loop races that deadline against the SDK stream, so a DEADLINED hold
 * can never wedge the turn: while stdin is held the CLI waits on us and we wait
 * on the CLI, and without something to break that tie neither the loop's exit
 * nor its `finally` would be reached.
 *
 * A hold taken FOR a live agent is never given a deadline in the first place —
 * a clock would fire straight into the segment the agent is working in. It is
 * bounded instead by the SDK's level signal (the agent leaving the set ends the
 * hold), by the stall watchdog — `SESSIONS.TURN_STALL_TIMEOUT_MS`, ten minutes
 * of stream silence, after which `withStallGuard` interrupts the runtime and
 * closes the turn (`trigger-turn.ts`) — and by the operator's Stop.
 *
 * A DEADLINED hold that finds an agent live when it expires is a different
 * case: it re-arms rather than closing (see {@link settleStdinAtDeadline}), so
 * that wait stays bounded by a timer of its own.
 *
 * @module services/runtimes/claude-code/messaging/stdin-hold
 */
import { logger } from '../../../../lib/logger.js';
import type { TurnLiveness } from './turn-liveness.js';

/**
 * How long an owed delivery may hold stdin open, measured from the `result`
 * that held it.
 *
 * A DEADLINE, deliberately, not an idle timer. An idle timer is re-armed by any
 * message, so unrelated `task_progress` frames from other still-running tasks
 * would keep pushing it back and the bound it was supposed to provide would
 * never arrive. Measured from the hold, the wait is bounded no matter how
 * chatty the stream is.
 *
 * What it really bounds is SILENCE AFTER A RESULT. The window is normally
 * sub-second — the gap between a task settling and the CLI opening the segment
 * that drains it — and the segment starting releases it (`release()`), so in the
 * ordinary case it never fires at all.
 */
export const DEFERRED_CLOSE_TIMEOUT_MS = 30_000;

/** The armed-or-not deadline a held-back close is racing against. */
export interface DeferredClose {
  /**
   * The live deadline to race, or `undefined` when no hold is deadlined. It
   * resolves to `'expired'`, never rejects.
   */
  readonly deadline: Promise<'expired'> | undefined;
  /** Start the countdown, replacing any deadline already armed. */
  arm: () => void;
  /** Drop the deadline: the close it guarded is happening now, or is no longer wanted. */
  release: () => void;
}

/**
 * Build the deadline holder for one turn. At most one timer is ever live, and
 * it is unref'd so it can never by itself hold the process open.
 *
 * @param timeoutMs - How long a deadlined hold may last
 */
export function createDeferredClose(timeoutMs: number = DEFERRED_CLOSE_TIMEOUT_MS): DeferredClose {
  let deadline: Promise<'expired'> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const release = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    deadline = undefined;
  };

  return {
    get deadline() {
      return deadline;
    },
    arm: () => {
      release();
      deadline = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), timeoutMs);
        timer.unref?.();
      });
    },
    release,
  };
}

/** Everything {@link settleStdinAtResult} needs to decide and act. */
export interface StdinSettleArgs {
  /** The DorkOS session id, for the log line. */
  sessionId: string;
  /** This turn's liveness tracker, already fed the `result`. */
  liveness: TurnLiveness;
  /** This turn's deadline holder. */
  deferredClose: DeferredClose;
  /** Ends the held input stream — the EOF this whole module is careful with. */
  close: () => void;
}

/**
 * Close the CLI's stdin, or hold it open past this `result`.
 *
 * Closing while the turn is still alive is not a lost steering opportunity —
 * it is what CANCELS every hook-matched tool the CLI runs afterwards, and what
 * drops every corrective push (DOR-1238). So the close happens only at a
 * `result` where nothing is running and nothing is owed; every other `result`
 * holds, deadlined only when {@link TurnLiveness.holdOpenAtResult} says the
 * hold is for an owed delivery alone.
 *
 * @param args - The session, its liveness tracker, its deadline, and the close
 */
export function settleStdinAtResult(args: StdinSettleArgs): void {
  const { sessionId, liveness, deferredClose, close } = args;
  const decision = liveness.holdOpenAtResult();
  // At most one live timer, whichever way this goes.
  deferredClose.release();
  if (!decision.hold) {
    logger.debug('[sendMessage] closing the input stream at a result', { session: sessionId });
    close();
    return;
  }
  if (decision.armDeadline) deferredClose.arm();
  logger.debug('[sendMessage] holding the input stream open past a result', {
    session: sessionId,
    liveAgents: liveness.liveAgentCount(),
    owedNotifications: liveness.owedCount(),
    deadlineArmed: decision.armDeadline,
  });
}

/**
 * The deadline fired. Close stdin — UNLESS a background agent has become live
 * since it was armed, in which case keep holding and ask again a window later.
 *
 * The deadline is armed for an owed delivery with nothing live, but the turn
 * moves underneath it: the segment it was waiting for can start, and the model
 * can launch another helper inside that segment. Closing on the timer alone
 * would then EOF stdin under a live agent — the very thing this module exists
 * to prevent — so liveness is re-asked at the moment of the close rather than
 * trusted from the moment of the arm.
 *
 * The re-arm is what keeps that answer bounded. Simply returning would leave
 * the hold with no timer at all: the agent can leave the level set without a
 * `task_notification`, and if the CLI then says nothing more there is no
 * `result` to re-decide at and nothing until the ten-minute stall guard. Asking
 * again one window later is the same shape as the registry answering a declined
 * reap — a bounded wait, not a spin.
 *
 * @param args - The session, its liveness tracker, its deadline, and the close
 * @returns True when stdin was closed, false when the hold continues
 */
export function settleStdinAtDeadline(args: StdinSettleArgs): boolean {
  const { sessionId, liveness, deferredClose, close } = args;
  deferredClose.release();
  const liveAgents = liveness.liveAgentCount();
  if (liveAgents > 0) {
    logger.debug('[sendMessage] deadline expired but a background agent is live; still holding', {
      session: sessionId,
      liveAgents,
    });
    // Ask again a window from now rather than waiting for ever.
    deferredClose.arm();
    return false;
  }
  logger.warn('[sendMessage] deferred close expired; releasing input stream', {
    session: sessionId,
    owedNotifications: liveness.owedCount(),
  });
  close();
  return true;
}
