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
 * - `ceiling` — reaped because its work ran past the four-hour ceiling with
 *   nothing heard from it. A plain idle reap only ever takes a quiet process,
 *   so no turn is open on one.
 * - `evict` — torn down with its session record, by the idle sweep, a pause or
 *   a relaunch.
 * - `shutdown` — DorkOS itself is stopping.
 */
export type RetireReason = 'ceiling' | PumpTeardownReason;

/**
 * Name the reason from the pump's state change.
 *
 * @param to - The state the pump moved to
 * @param teardown - The pump's own teardown reason, when it was torn down
 */
export function retireReasonOf(
  to: 'cold' | 'reaped',
  teardown: PumpTeardownReason | undefined
): RetireReason {
  return to === 'reaped' ? 'ceiling' : (teardown ?? 'evict');
}

const RETIRED_WORDS: Record<RetireReason, string> = {
  ceiling: 'The agent ran past four hours without a word, so DorkOS closed it.',
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
