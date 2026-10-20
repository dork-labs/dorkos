/**
 * Reads a room post's stored hold (DOR-3037): whether a person wrote it from
 * Wi-Fi, so the turns it starts and the beats that read it are held to the
 * runtime's default. Kept on the row (`room_entries.held_to_default`), so the
 * hold outlives a restart; read by `entryHeldToDefault` when this process did
 * not write the post itself.
 *
 * @module server/services/rooms/limits/stored-entry-hold
 */
import { and, eq, roomEntries, type Db } from '@dorkos/db';

/**
 * A reader for one post's stored hold, by its room and id (the table's unique
 * index), for `setStoredEntryHoldReader`.
 *
 * @param db - The rooms database.
 */
export function storedEntryHoldReader(db: Db): (roomId: string, entryId: string) => boolean {
  return (roomId, entryId) =>
    db
      .select({ held: roomEntries.heldToDefault })
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.id, entryId)))
      .get()?.held === true;
}
