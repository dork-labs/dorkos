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

/** Chats this process refuses for a crash loop, until a turn completes on them again. */
const crashRefused = new Set<string>();
const CRASH_REFUSED_MEMORY = 10_000;

/**
 * Spend a chat's failed-turn record because its own process refuses it for a crash loop, and
 * write none for it until a turn completes there again, so a restart never unlocks what that
 * process refused (DOR-4626). Best effort: a write that fails leaves the record, which is still
 * bound by the latest-turn and current-guard checks. Keyed as the crash policy names the chat.
 *
 * @param sessionId - The chat whose process keeps dying.
 */
export function refuseFailedSeat(sessionId: string): void {
  crashRefused.delete(sessionId);
  crashRefused.add(sessionId);
  if (crashRefused.size > CRASH_REFUSED_MEMORY)
    crashRefused.delete(crashRefused.values().next().value!);
  try {
    failedSeatLedger()?.consume(sessionId);
  } catch (err) {
    logger.warn('[rooms] could not spend a crash-looping room chat’s recovery record', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A turn completed on the chat, so its crash policy no longer refuses it.
 *
 * @param sessionId - The chat, as its crash policy names it.
 */
export function clearFailedSeatRefusal(sessionId: string): void {
  crashRefused.delete(sessionId);
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
  if (crashRefused.has(sessionId)) return;
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
