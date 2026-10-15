import { communityRoomMirrors, rooms, roomEntries, eq, sql, type DbTransaction } from '@dorkos/db';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { type NewRoomEntry } from '../data/room-rows.js';
import { readOriginalRoomStoreMethodView } from '../room-store.js';

/** Original appendEntry responsibility after exact constructor-private store recognition. */
export function appendEntry(
  opaqueRoomStoreKey: object,
  entry: NewRoomEntry,
  within?: (tx: DbTransaction) => void,
  bind?: (tx: DbTransaction, seq: number) => void
): RoomEntry {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  return facet.db.transaction(
    (tx) => {
      within?.(tx);
      const allocated = tx
        .select({ next: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0) + 1` })
        .from(roomEntries)
        .where(eq(roomEntries.roomId, entry.roomId))
        .get();
      const seq = allocated?.next ?? 1;
      // A post written here into a mirrored Community room follows the room's remote history,
      // in `seq` order (`room_entries.timeline_band`). Read from the table, not from the
      // in-memory registration: a row stored without its place would drop out of the room's
      // timeline for good.
      const mirrored =
        tx
          .select({ id: communityRoomMirrors.localRoomId })
          .from(communityRoomMirrors)
          .where(eq(communityRoomMirrors.localRoomId, entry.roomId))
          .get() !== undefined;

      tx.insert(roomEntries)
        .values({
          roomId: entry.roomId,
          seq,
          timelineBand: mirrored ? 1 : null,
          timelinePos: mirrored ? seq : null,
          id: entry.id,
          authorId: entry.authorId,
          kind: entry.kind,
          body: JSON.stringify(entry.body),
          mentions: JSON.stringify(entry.mentions),
          mentionSpans: JSON.stringify(entry.mentionSpans ?? []),
          sessionId: entry.sessionId,
          cascadeRoot: entry.cascadeRoot,
          cascadeDepth: entry.cascadeDepth,
          // Which turn wrote this, when a turn did — the repeat rule's unit
          // (DOR-1434). Every writer that is not inside a turn omits it, and
          // `null` is the honest record of "no turn behind this write".
          dispatchId: entry.dispatchId ?? null,
          parentEntryId: entry.parentEntryId,
          threadRootEntryId: entry.threadRootEntryId,
          signature: null,
          createdAt: entry.createdAt,
        })
        .run();

      tx.update(rooms)
        .set({ lastActivityAt: entry.createdAt })
        .where(eq(rooms.id, entry.roomId))
        .run();

      bind?.(tx, seq);

      return {
        roomId: entry.roomId,
        seq,
        id: entry.id,
        authorId: entry.authorId,
        kind: entry.kind,
        body: entry.body,
        mentions: [...entry.mentions],
        mentionSpans: [...(entry.mentionSpans ?? [])],
        sessionId: entry.sessionId,
        cascadeRoot: entry.cascadeRoot,
        cascadeDepth: entry.cascadeDepth,
        parentEntryId: entry.parentEntryId,
        threadRootEntryId: entry.threadRootEntryId,
        signature: null,
        createdAt: entry.createdAt,
      };
    },
    { behavior: 'immediate' }
  );
}
