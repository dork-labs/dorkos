/**
 * What a failed room chat's turn carries into its one recovery, and the server-side write that
 * keeps it past a restart (DOR-4626). Both the live recovery and the durable record build the
 * carry here, so a recovery after a restart holds exactly what one before it would.
 *
 * @module services/rooms/reseat/failed-seat-record
 */
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { lastTurnLevelOf } from '../../core/turn-power/turn-levels.js';
import { carryFrom, joinCeilings } from '../handoff/seat-carry.js';
import { logger } from '../../../lib/logger.js';
import type { FailedSeatLedger, FailedSeatRecord } from './failed-seat-ledger.js';

/**
 * The failed turn's carry with its own level joined into the ceiling, or `null` when this process
 * recorded no level for the chat. Unknown is never a level, so it never becomes a recovery.
 *
 * @param sessionId - The failed chat.
 * @param agentPath - Its agent's home.
 */
export function failedTurnCarry(
  sessionId: string,
  agentPath: string
): FailedSeatRecord['carry'] | null {
  const level = lastTurnLevelOf(sessionId);
  if (!level) return null;
  // The old turn's positively recorded effective bounds survive its first fresh turn.
  // Outside-word provenance alone does not manufacture a permission ceiling.
  const prior = carryFrom(sessionId, agentPath);
  return { ...prior, permissionCeiling: joinCeilings(prior.permissionCeiling, level) ?? level };
}

/** The server's failed-chat ledger, or `undefined` while no database is open. */
export function failedSeatLedger(): FailedSeatLedger | undefined {
  try {
    return runtimeRegistry.requiredLaunches().failures;
  } catch {
    return undefined;
  }
}

/**
 * Keep a room chat's failed turn for one recovery by a later server process. Called by the
 * runtime that saw the failure, at the moment it saw it; a chat with no recorded level, or a
 * write that fails, keeps nothing, so a restart refuses recovery rather than guessing.
 *
 * @param sessionId - The failed chat, as its turn was sent.
 * @param agentPath - Its agent's home, when known.
 * @param failure - The failure's dispatch, entry, account folder and bill, as the runtime saw them.
 */
export function recordFailedSeatTurn(
  sessionId: string,
  agentPath: string | undefined,
  failure: Omit<FailedSeatRecord, 'carry'>
): void {
  try {
    const carry = failedTurnCarry(sessionId, agentPath ?? '');
    if (carry) failedSeatLedger()?.record(sessionId, { ...failure, carry });
  } catch (err) {
    logger.warn('[rooms] could not keep a failed room chat for recovery after a restart', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
