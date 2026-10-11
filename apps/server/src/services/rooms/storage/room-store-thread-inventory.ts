import {
  rooms,
  roomMembers,
  roomEntries,
  readCursors,
  eq,
  and,
  isNotNull,
  alias,
  sql,
  count,
  desc,
} from '@dorkos/db';
import { type ThreadAggregateRow } from '../data/room-rows.js';
import { readOriginalRoomStoreMethodView } from '../room-store.js';

/** Original listThreadsForMember responsibility after exact constructor-private store recognition. */
export function listThreadsForMember(
  opaqueRoomStoreKey: object,
  viewerAuthorId: string,
  limit: number,
  cursor: 'user' | 'membership'
): ThreadAggregateRow[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const root = alias(roomEntries, 'thread_root');
  const readCursor = sql`COALESCE(${readCursors.lastReadSeq}, 0)`;
  // MAX over the replies' timestamps: a thread's activity is its newest
  // reply. Named once and reused for the ORDER BY, so the sort and the value
  // the row reports can never be two different expressions.
  const lastActivityAt = sql<string>`MAX(${roomEntries.createdAt})`;
  return (
    facet.db
      .select({
        roomId: roomEntries.roomId,
        roomKind: rooms.kind,
        roomSlug: rooms.slug,
        roomTitle: rooms.title,
        rootEntryId: root.id,
        rootAuthorId: root.authorId,
        rootBody: root.body,
        replyCount: count(),
        unreadCount: sql<number>`SUM(CASE WHEN ${roomEntries.seq} > ${
          cursor === 'user' ? readCursor : roomMembers.lastReadSeq
        } THEN 1 ELSE 0 END)`,
        lastActivityAt,
      })
      .from(roomEntries)
      .innerJoin(
        root,
        and(eq(root.roomId, roomEntries.roomId), eq(root.id, roomEntries.threadRootEntryId))
      )
      .innerJoin(rooms, eq(rooms.id, roomEntries.roomId))
      // The membership join is the privacy boundary and stays INNER whichever
      // cursor is measured; the cursor join below is LEFT, because having read
      // nothing is not the same as not being here.
      .innerJoin(
        roomMembers,
        and(eq(roomMembers.roomId, roomEntries.roomId), eq(roomMembers.authorId, viewerAuthorId))
      )
      .leftJoin(
        readCursors,
        and(
          eq(readCursors.userId, viewerAuthorId),
          eq(readCursors.threadKind, 'room'),
          eq(readCursors.threadId, roomEntries.roomId)
        )
      )
      .where(
        and(
          isNotNull(roomEntries.threadRootEntryId),
          eq(rooms.archived, false),
          sql`(${root.authorId} = ${viewerAuthorId} OR EXISTS (
            SELECT 1 FROM ${roomEntries} AS participation
            WHERE participation.room_id = ${roomEntries.roomId}
              AND participation.thread_root_entry_id = ${roomEntries.threadRootEntryId}
              AND participation.author_id = ${viewerAuthorId}
          ))`
        )
      )
      .groupBy(roomEntries.roomId, roomEntries.threadRootEntryId)
      // The id breaks a tie so two threads answered in the same second never
      // swap places between reads, the same rule every room list ends on.
      .orderBy(desc(lastActivityAt), desc(root.id))
      .limit(limit)
      .all()
  );
}
