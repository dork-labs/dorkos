/**
 * The small moves that ride along with a session's rekey in the runtime
 * registry (who started it, when it was touched, a task run's chat), each
 * isolated so its failure costs only what it moves.
 *
 * @module services/session/origin/rekey-moves
 */
import type { Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';
import { moveBeatChats } from '../../heartbeats/heartbeat-store.js';
import { moveRunSessions } from '../../tasks/session/active-run-sessions.js';

/**
 * A task run's row and a beat's row name their chat by the same id its spin-offs'
 * started-by rows do, so a scheduled chat's lineage reads the same after a restart
 * (DOR-3703, MB1, MD).
 *
 * @param db - The database the rows are kept in.
 * @param fromId - The id the chat was known by.
 * @param toId - Its canonical id.
 */
export function moveScheduledChats(db: Db, fromId: string, toId: string): void {
  moveRunSessions(db, fromId, toId);
  moveBeatChats(db, fromId, toId);
}

/**
 * One move that rides along with a session's rekey, isolated so its failure
 * costs only what it moves, never the settings row (logged, as each always was).
 *
 * @param what - What moves, for the log line.
 * @param fromId - The id the session was known by.
 * @param toId - Its canonical id.
 * @param move - The move.
 */
export function moveAlongside(what: string, fromId: string, toId: string, move: () => void): void {
  try {
    move();
  } catch (err) {
    logger.warn(`[RuntimeRegistry] could not move ${what}`, {
      fromId,
      toId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
