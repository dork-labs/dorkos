/**
 * The pre-flight every turn-opening path runs: end a turn the runtime could not
 * finish, and wait for the projection to agree, BEFORE opening a turn of its own
 * (DOR-1295).
 *
 * ## The ordering this exists for
 *
 * DOR-1294 gave the claude-code windower a backstop — a dispatch that finds a
 * window still open ABANDONS it, so a session whose `result` went somewhere else
 * can still run another turn. That ended the wedge and opened a subtler failure,
 * because of WHERE the abandonment ran. It ran inside the successor's own
 * generator, and {@link feedProjector} mints the successor's `turn_start` before
 * it pulls that generator a single time. So the abandoned turn's terminal
 * reliably landed INSIDE the successor's window: the healthy turn settled
 * `error` with the abandoned turn's message attached, the composer went idle
 * mid-stream while the agent was still producing, and the durable rows came out
 * as one set spanning both turns — after which the successor's own `turn_end`
 * had no open turn left to flush.
 *
 * Nothing INSIDE the successor's dispatch can fix that, because by then the
 * successor's turn is already open. So the repair moves up here, to the seam
 * that composes a turn, where the successor is still only an intention.
 *
 * ## Why the wait is on the PROJECTION, not on the runtime's answer
 *
 * {@link AgentRuntime.settleOpenTurn} returns as soon as the runtime has pushed
 * the terminal at its own stream. That stream then unwinds through the mapper,
 * the stall guard and `feedProjector`, and only `feedProjector`'s `finally`
 * ingests the `turn_end`. Waiting on the runtime would therefore be waiting on
 * the wrong thing — the projector is where the ordering is observable, so the
 * projector is what is waited on.
 *
 * ## Why the wait is UNCONDITIONAL
 *
 * It does not ask whether the runtime settled anything, and gating it on that
 * answer would be strictly worse. The wait is free when nothing is open
 * ({@link SessionStateProjector.awaitTurnSettled} resolves immediately on a null
 * in-progress turn), and there are two ways a turn is still open that no runtime
 * seam reports:
 *
 * - **A turn that ended but has not finished closing.** claude-code's windower
 *   clears its window synchronously on the `result` and only then fetches the
 *   closing accounting — up to `WINDOW_USAGE_TIMEOUT_MS` (~8s) during which
 *   `settleOpenTurn` honestly answers `false` while the projection still holds
 *   the turn open.
 * - **The resume path, and every other runtime**, which have no seam here at all
 *   and would otherwise get no ordering guarantee whatever.
 *
 * ## Why abandoning here is safe ahead of the directory-boundary gate
 *
 * `SessionTurnWindows.dispatch` validates the working directory before it sends
 * anything, and this runs EARLIER than that — so a turn that is about to be
 * refused by the boundary can still have ended the turn ahead of it. That
 * inverts the written order, and it is safe rather than merely tolerated: what
 * gets abandoned is a window that is stranded BY CONSTRUCTION. A caller reaching
 * here holds the session's write-lock and its queue slot for the whole of its
 * stream, so a window still open under it belongs to a turn nobody is driving
 * any more. Ending it costs a turn that was never going to finish, and the
 * boundary gate protects a SUBPROCESS's working directory — which nothing here
 * touches, because no dispatch has happened yet.
 *
 * @module services/session/settle-open-turn
 */
import { logError, logger } from '../../lib/logger.js';
import type { SessionStateProjector } from './session-state-projector.js';

/** The one port this needs — the optional runtime seam, however it was wired. */
export interface SettleOpenTurnPort {
  /**
   * End a turn the runtime has left open, answering whether it found one.
   * Absent for a runtime that cannot strand a turn.
   */
  settleOpenTurn?(sessionId: string): Promise<boolean>;
}

/**
 * End whatever turn this session still has open, then wait for the projection to
 * settle — so the turn the caller is about to open is its own.
 *
 * **Never throws, and never rejects.** A runtime that misbehaves here is a
 * runtime that failed to perform a REPAIR, and a repair may not be the thing
 * that fails the next message: the throw is logged and the turn starts anyway,
 * which is exactly the behaviour of a runtime that implements nothing at all.
 * The interface asks for the same thing in words ({@link
 * AgentRuntime.settleOpenTurn}) and conformance C8 holds the shipped runtimes to
 * it; this is what makes it true for a future adapter that does not read either.
 *
 * @param sessionId - The session about to open a turn, as the id the runtime's
 *   own turn path is addressed with (the caller passes what it will pass
 *   `sendMessage`, because that is the id the runtime's wiring is filed under)
 * @param projector - The session's projector — the thing whose turn must be
 *   closed before the caller opens the next one
 * @param deps - The caller's runtime port; an absent seam is a no-op settle
 * @param budgetMs - The MOST this may wait for the terminal to land. Always
 *   bounded: the abandoned turn's stream may have no consumer left at all (a
 *   request that went away, a generator nobody is pulling), in which case
 *   nothing will ever close that turn and the caller's message must not hang on
 *   it. Exhausting the budget resolves rather than rejects — a turn opening
 *   beside a stale one is the pre-DOR-1295 behaviour, which is bad but is not a
 *   reason to refuse a person's message.
 */
export async function settleOpenTurnBefore(
  sessionId: string,
  projector: SessionStateProjector,
  deps: SettleOpenTurnPort,
  budgetMs: number
): Promise<void> {
  try {
    if ((await deps.settleOpenTurn?.(sessionId)) === true) {
      // Said at the seam that caused it, because this is the moment a person's
      // PREVIOUS reply is marked failed — and the only place that story reads
      // as one thing rather than as two unrelated log lines.
      logger.warn('[settle-open-turn] ended a turn that never finished so the next one can start', {
        sessionId,
      });
    }
  } catch (err) {
    logger.warn('[settle-open-turn] the runtime threw while settling; starting the turn anyway', {
      sessionId,
      ...logError(err),
    });
  }
  await projector.awaitTurnSettled(Math.max(0, budgetMs));
}
