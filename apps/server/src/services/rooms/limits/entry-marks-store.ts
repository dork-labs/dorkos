/**
 * Room posts' turn marks on disk (DOR-3036, `specs/turn-marks`): the `room_entries.turn_marks`
 * column behind `turn-levels.ts`'s {@link EntryMarksStore}, so a post a teammate's chain wrote is
 * still read as marked after a restart, when the in-memory level it was kept with is gone.
 *
 * @module server/services/rooms/limits/entry-marks-store
 */
import { and, eq } from 'drizzle-orm';
import { roomEntries, type Db } from '@dorkos/db';
import type { EntryMarksStore } from '../../core/turn-power/turn-levels.js';
import { parseStoredMarks } from '../../core/turn-power/turn-marks.js';

/**
 * The store over one database's `room_entries`.
 *
 * @param db - The database the room store writes.
 */
export function createEntryMarksStore(db: Db): EntryMarksStore {
  return {
    write(roomId, entryId, marks) {
      db.update(roomEntries)
        .set({ turnMarks: JSON.stringify(marks) })
        .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.id, entryId)))
        .run();
    },
    read(roomId, entryId) {
      const row = db
        .select({ turnMarks: roomEntries.turnMarks })
        .from(roomEntries)
        .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.id, entryId)))
        .get();
      if (!row) return undefined;
      return row.turnMarks === null ? null : parseStoredMarks(row.turnMarks);
    },
  };
}
