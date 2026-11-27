/**
 * The small moves that ride along with a session's rekey in the runtime
 * registry (who started it, when it was touched, a task run's chat), each
 * isolated so its failure costs only what it moves.
 *
 * @module services/session/origin/rekey-moves
 */
import type { Db, DbTransaction } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';

/** Moves a scheduled chat's rows (a task run's, a beat's) to its canonical id. */
export type ScheduledChatMoves = (db: Db | DbTransaction, fromId: string, toId: string) => void;

/**
 * The space side's moves, handed over at startup: the task run and beat rows
 * live in tables the computer side does not name (spec
 * `computer-side-starts-alone` §5.12). Unset, a rekey moves none of them.
 */
let scheduledChatMoves: ScheduledChatMoves | undefined;

/**
 * Register (or clear) how a scheduled chat's rows move with its rekey.
 *
 * @param moves - The moves, or `undefined` to clear them.
 */
export function setScheduledChatMoves(moves: ScheduledChatMoves | undefined): void {
  scheduledChatMoves = moves;
}

/**
 * A task run's row and a beat's row name their chat by the same id its spin-offs'
 * started-by rows do, so a scheduled chat's lineage reads the same after a restart
 * (DOR-3703, MB1, MD). The rows are moved by what {@link setScheduledChatMoves}
 * registered, inside the caller's transaction when it passes one.
 *
 * @param db - The database the rows are kept in.
 * @param fromId - The id the chat was known by.
 * @param toId - Its canonical id.
 */
export function moveScheduledChats(db: Db | DbTransaction, fromId: string, toId: string): void {
  scheduledChatMoves?.(db, fromId, toId);
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
