/**
 * Why DorkOS ended a process while a turn was still open on it, and the words
 * that turn ends on (DOR-2681, DOR-2705).
 *
 * @module services/runtimes/claude-code/sessions/diagnostics/retired-turn
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../lib/logger.js';
import type { PumpTeardownReason } from '../session-pump-contract.js';

/**
 * Why a process was let go.
 *
 * - `limit` — the 16-hour limit, `SESSIONS.TURN_HARD_CEILING_MS`: one turn,
 *   or one continuous busy stretch of turns, ran that long however much it was
 *   still saying. Reached only through DorkOS's own reap or record sweep.
 * - `ceiling` — reaped past the four-hour ceiling while the open turn's main
 *   thread had said nothing for four hours. Helpers' frames do not count
 *   (`isTurnActivity`). A plain idle reap only takes a quiet process, so no
 *   turn is open on one.
 * - `evict` — torn down by a person's pause, a credits unlink, a relaunch, or
 *   the idle sweep for any other reason.
 * - `shutdown` — DorkOS itself is stopping.
 */
export type RetireReason = 'limit' | 'ceiling' | 'evict' | 'shutdown';

/** What {@link retireReasonOf} reads off the pump. `SessionPump` satisfies it. */
export interface RetiringPump {
  /** Why the pump was torn down, once it has been. */
  readonly teardownReason?: PumpTeardownReason;
  /** Whether the process passed the 16-hour limit. */
  isPastHardLimit?(): boolean;
}

/**
 * Name the reason from the pump's state change.
 *
 * Whoever ended it outranks the limit: a shutdown says so, and so does a
 * person's pause or a relaunch (`evict`). The limit is named only when DorkOS
 * itself let the process go, by a reap or by its record sweep.
 *
 * @param to - The state the pump moved to
 * @param pump - The pump that moved
 */
export function retireReasonOf(to: 'cold' | 'reaped', pump: RetiringPump): RetireReason {
  if (to === 'cold' && pump.teardownReason === 'shutdown') return 'shutdown';
  const ownCleanUp = to === 'reaped' || pump.teardownReason === 'sweep';
  if (ownCleanUp && pump.isPastHardLimit?.() === true) return 'limit';
  return to === 'reaped' ? 'ceiling' : 'evict';
}

const RETIRED_WORDS: Record<RetireReason, string> = {
  limit: 'The agent hit the 16-hour limit on nonstop work, so DorkOS closed it.',
  ceiling: 'The agent sent nothing for four hours, so DorkOS closed it.',
  evict: 'DorkOS closed the agent before it finished this turn.',
  shutdown: 'DorkOS shut down before the agent finished this turn.',
};

/**
 * The `result` for a turn whose process DorkOS ended on purpose while the turn
 * was still open.
 *
 * @param sessionId - The session the window belongs to
 * @param reason - Why the process was let go
 */
export function retiredResult(sessionId: string, reason: RetireReason): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [RETIRED_WORDS[reason]],
    uuid: `retired-${sessionId}`,
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/**
 * Say which turn was ended with its process, and why. The reason used to be
 * invisible: a busy turn was ended and no log line said by what (DOR-2705).
 *
 * @param sessionId - The session the turn belongs to
 * @param reason - Why the process was let go
 * @param turnIds - The ids of the messages the turn was answering
 */
export function logRetiredTurn(
  sessionId: string,
  reason: RetireReason,
  turnIds: readonly string[]
): void {
  logger.warn('[SessionTurnWindows] ended an open turn with its process', {
    sessionId,
    reason,
    turnIds,
  });
}
