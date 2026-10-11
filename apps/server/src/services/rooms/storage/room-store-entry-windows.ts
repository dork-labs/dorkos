import { roomEntries, eq, and, inArray, notInArray, lte, gt, ne, sql, count } from '@dorkos/db';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { toEntry } from '../data/room-rows.js';
import { readOriginalRoomStoreMethodView, type TopLevelWindow } from '../room-store.js';

/** Original listEntries responsibility after exact constructor-private store recognition. */
export function listEntries(
  opaqueRoomStoreKey: object,
  roomId: string,
  opts: { before?: number; afterSeq?: number; threadRootEntryId?: string; limit: number }
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const conditions = [eq(roomEntries.roomId, roomId)];
  if (opts.before !== undefined) conditions.push(facet.beforeTimelineEntry(roomId, opts.before));
  if (opts.afterSeq !== undefined) conditions.push(gt(roomEntries.seq, opts.afterSeq));
  if (opts.threadRootEntryId !== undefined) {
    conditions.push(eq(roomEntries.threadRootEntryId, opts.threadRootEntryId));
  }
  const rows = facet.db
    .select()
    .from(roomEntries)
    .where(and(...conditions, facet.timelineScope(roomId, opts.threadRootEntryId)))
    .orderBy(...facet.timelineOrder(roomId, 'desc'))
    .limit(opts.limit)
    .all();
  return rows.reverse().map(toEntry);
}

/** Original listEntriesBySeq responsibility after exact constructor-private store recognition. */
export function listEntriesBySeq(
  opaqueRoomStoreKey: object,
  roomId: string,
  seqs: readonly number[]
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const wanted = [...new Set(seqs)];
  if (wanted.length === 0) return [];
  return facet.db
    .select()
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId), inArray(roomEntries.seq, wanted)))
    .orderBy(roomEntries.seq)
    .all()
    .map(toEntry);
}

/** Original listEntriesByIds responsibility after exact constructor-private store recognition. */
export function listEntriesByIds(
  opaqueRoomStoreKey: object,
  roomId: string,
  ids: readonly string[]
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  return facet.db
    .select()
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId), inArray(roomEntries.id, wanted)))
    .orderBy(...facet.timelineOrder(roomId, 'asc'))
    .all()
    .map(toEntry);
}

/** Original listUnreadEntries responsibility after exact constructor-private store recognition. */
export function listUnreadEntries(
  opaqueRoomStoreKey: object,
  roomId: string,
  opts: {
    afterSeq: number;
    throughSeq: number;
    excludeAuthorId: string;
    excludeEntryIds: readonly string[];
    limit: number;
    threadRootEntryId?: string;
  }
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const rows = facet.db
    .select()
    .from(roomEntries)
    .where(
      and(
        eq(roomEntries.roomId, roomId),
        gt(roomEntries.seq, opts.afterSeq),
        lte(roomEntries.seq, opts.throughSeq),
        ne(roomEntries.authorId, opts.excludeAuthorId),
        // `notInArray` over an EMPTY list is `false` in some dialects, so the
        // clause is omitted rather than emitted empty. Unreachable today — the
        // triggering entry is always in it — and left as a property of the
        // method rather than of its one caller.
        ...(opts.excludeEntryIds.length === 0
          ? []
          : [notInArray(roomEntries.id, [...opts.excludeEntryIds])]),
        // Reads `idx_room_entries_thread_root`, whose third column is `seq` —
        // so a thread scattered through a long channel is paged rather than
        // sorted (migration 0040, and the measurement in
        // {@link RoomStore.listRecentPostsByOthers}).
        ...(opts.threadRootEntryId === undefined
          ? []
          : [eq(roomEntries.threadRootEntryId, opts.threadRootEntryId)]),
        // In SQL with the rest of them, for the reason the cap is: filtering
        // afterwards would return fewer than `limit` rows and make the
        // truncation flag lie. `json_extract` reads the subject out of the
        // body column; a row with no subject yields NULL, and `IS NOT` is the
        // null-safe comparison that keeps it.
        sql`json_extract(${roomEntries.body}, '$.subjectAuthorId') IS NOT ${opts.excludeAuthorId}`
      )
    )
    .orderBy(...facet.timelineOrder(roomId, 'desc'))
    .limit(opts.limit)
    .all();
  return rows.reverse().map(toEntry);
}

/** Original listRecentTopLevelEntries responsibility after exact constructor-private store recognition. */
export function listRecentTopLevelEntries(
  opaqueRoomStoreKey: object,
  roomId: string,
  opts: TopLevelWindow & { limit: number }
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  if (opts.limit <= 0) return [];
  const rows = facet.db
    .select()
    .from(roomEntries)
    .where(facet.topLevelWindow(roomId, opts))
    .orderBy(...facet.timelineOrder(roomId, 'desc'))
    .limit(opts.limit)
    .all();
  return rows.reverse().map(toEntry);
}

/** Original countRecentTopLevelEntries responsibility after exact constructor-private store recognition. */
export function countRecentTopLevelEntries(
  opaqueRoomStoreKey: object,
  roomId: string,
  opts: TopLevelWindow
): number {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db
    .select({ total: sql<number>`count(*)` })
    .from(roomEntries)
    .where(facet.topLevelWindow(roomId, opts))
    .get();
  return row?.total ?? 0;
}

/** Original listEntriesByAuthor responsibility after exact constructor-private store recognition. */
export function listEntriesByAuthor(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string,
  limit: number
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const rows = facet.db
    .select()
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.authorId, authorId)))
    .orderBy(...facet.timelineOrder(roomId, 'desc'))
    .limit(limit)
    .all();
  return rows.reverse().map(toEntry);
}

/** Original listRecentPostsByOthers responsibility after exact constructor-private store recognition. */
export function listRecentPostsByOthers(
  opaqueRoomStoreKey: object,
  roomId: string,
  opts: { threadRootEntryId: string | null; excludeAuthorId: string; limit: number }
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  return facet.recentPostsInScope(roomId, opts);
}

/** Original listRecentPostsInScope responsibility after exact constructor-private store recognition. */
export function listRecentPostsInScope(
  opaqueRoomStoreKey: object,
  roomId: string,
  opts: { threadRootEntryId: string | null; limit: number }
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  return facet.recentPostsInScope(roomId, { ...opts, excludeAuthorId: null });
}
