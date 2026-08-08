/**
 * Reclaiming files that were uploaded and never posted.
 *
 * A room attachment is written in two steps — the bytes go up, then a message
 * names them — and a person who attaches a file and then closes the tab leaves
 * the first step without the second. Those bytes belong to nobody: no entry
 * references them, no reader can reach them (the serve route shows an unbound
 * file only to its uploader), and nothing else would ever remove them. Without
 * this module the staging area grows for the life of the install.
 *
 * **Opportunistic, not scheduled.** It runs on upload, which is the one moment
 * somebody is already touching this room's attachments — so the cost lands on
 * the path that creates the garbage rather than on a timer this feature would
 * otherwise have to introduce. That is the same shape the projection sweep
 * takes, and for the same reason.
 *
 * **Cheap by construction.** The read is the query
 * `idx_room_attachments_unbound` exists for: a partial index over
 * `(room_id, created_at) WHERE entry_id IS NULL`, which holds a row per STAGED
 * file rather than one per file ever posted.
 *
 * **Rows last, bytes first, and both guarded.** A file posted between the read
 * and the delete is somebody's message now, so `deleteUnbound` re-checks
 * `entry_id IS NULL` and this module only removes the bytes of rows it actually
 * deleted. Losing the file a message is about would be far worse than keeping a
 * few stale kilobytes for another day.
 *
 * @module server/services/rooms/attachments/unbound-sweep
 */
import { logError, logger } from '../../../lib/logger.js';
import type { AttachmentRowStore } from './attachment-row-store.js';
import type { RoomAttachmentStore } from './room-attachment-store.js';

/**
 * How long an uploaded-but-unposted file survives.
 *
 * A day, matching the projection sweep's own TTL. Long enough that a person who
 * attaches a file, gets interrupted, and comes back after lunch still has it;
 * short enough that abandoned uploads do not accumulate. Deliberately not a
 * setting: nobody has an opinion about this number until it is wrong, and it
 * has never been wrong.
 */
export const UNBOUND_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Drop the files this room staged and never sent.
 *
 * Never throws: reclamation is housekeeping, and an upload must not fail
 * because tidying up after an earlier one did.
 *
 * @param input.rows - Where the metadata lives.
 * @param input.store - Where the bytes live.
 * @param input.roomId - The room to sweep.
 * @param input.now - The clock, injectable so a test can age a row without
 *   fake timers.
 * @returns How many files were reclaimed.
 */
export async function sweepUnboundAttachments(input: {
  rows: AttachmentRowStore;
  store: RoomAttachmentStore;
  roomId: string;
  now?: () => number;
}): Promise<number> {
  const now = input.now ?? Date.now;
  const cutoff = new Date(now() - UNBOUND_ATTACHMENT_TTL_MS).toISOString();

  let stale;
  try {
    stale = input.rows.listUnboundBefore(input.roomId, cutoff);
  } catch (err) {
    logger.warn('[rooms] could not read unposted attachments to reclaim', {
      roomId: input.roomId,
      ...logError(err),
    });
    return 0;
  }
  if (stale.length === 0) return 0;

  let reclaimed = 0;
  for (const row of stale) {
    // **Claim the row first, one at a time, and only then touch the bytes.**
    // The delete re-checks `entry_id IS NULL`, so a file posted in the moment
    // since the read above wins and keeps both halves — a message never loses
    // the file it is about. Winning the row is also what makes deleting the
    // bytes safe: nothing can bind a row that no longer exists.
    try {
      if (input.rows.deleteUnbound(input.roomId, [row.id]) !== 1) continue;
    } catch (err) {
      logger.warn('[rooms] could not reclaim an unposted attachment row', {
        roomId: input.roomId,
        attachmentId: row.id,
        ...logError(err),
      });
      continue;
    }

    // Per file, so one unreadable file does not strand the rest of the sweep —
    // which is how a single bad row would otherwise keep a room's staging area
    // growing forever.
    try {
      await input.store.delete(input.roomId, row.id, row.extension);
      reclaimed += 1;
    } catch (err) {
      // The row is already gone, so nothing will look for these bytes again.
      // Logged at warn precisely because it is the one case this module cannot
      // clean up on a later pass.
      logger.warn('[rooms] reclaimed an attachment row but could not delete its bytes', {
        roomId: input.roomId,
        attachmentId: row.id,
        ...logError(err),
      });
    }
  }
  return reclaimed;
}
