import { roomEntries, eq, and, inArray, gt, or, isNull, sql, count } from '@dorkos/db';
import type { RoomEntry, RoomEntryBody, RoomMomentKind } from '@dorkos/shared/room-schemas';
import { parseEntryBody, toEntry } from '../data/room-rows.js';
import { readOriginalRoomStoreMethodView } from '../room-store.js';

/** Original listEntriesFrom responsibility after exact constructor-private store recognition. */
export function listEntriesFrom(
  opaqueRoomStoreKey: object,
  roomId: string,
  opts: { afterSeq: number; limit: number; threadRootEntryId?: string }
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  if (opts.limit <= 0) return [];
  const rows = facet.db
    .select()
    .from(roomEntries)
    .where(
      and(
        eq(roomEntries.roomId, roomId),
        facet.afterTimelineEntry(roomId, opts.afterSeq),
        opts.threadRootEntryId === undefined
          ? isNull(roomEntries.parentEntryId)
          : eq(roomEntries.threadRootEntryId, opts.threadRootEntryId),
        facet.timelineScope(roomId, opts.threadRootEntryId)
      )
    )
    .orderBy(...facet.timelineOrder(roomId, 'asc'))
    .limit(opts.limit)
    .all();
  return rows.map(toEntry);
}

/** Original countThreadRepliesFor responsibility after exact constructor-private store recognition. */
export function countThreadRepliesFor(
  opaqueRoomStoreKey: object,
  roomId: string,
  rootEntryIds: readonly string[]
): Map<string, { replyCount: number; lastReplyAt: string }> {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const summaries = new Map<string, { replyCount: number; lastReplyAt: string }>();
  const wanted = [...new Set(rootEntryIds)];
  if (wanted.length === 0) return summaries;
  const rows = facet.db
    .select({
      rootEntryId: roomEntries.threadRootEntryId,
      replyCount: count(),
      lastReplyAt: sql<string>`MAX(${roomEntries.createdAt})`,
    })
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId), inArray(roomEntries.threadRootEntryId, wanted)))
    .groupBy(roomEntries.threadRootEntryId)
    .all();
  for (const row of rows) {
    if (row.rootEntryId === null) continue;
    summaries.set(row.rootEntryId, {
      replyCount: row.replyCount,
      lastReplyAt: row.lastReplyAt,
    });
  }
  return summaries;
}

/** Original listEntriesAfter responsibility after exact constructor-private store recognition. */
export function listEntriesAfter(
  opaqueRoomStoreKey: object,
  roomId: string,
  afterSeq: number
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const rows = facet.db
    .select()
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId), gt(roomEntries.seq, afterSeq)))
    .orderBy(roomEntries.seq)
    .all();
  return rows.map(toEntry);
}

/** Original listEntriesForExport responsibility after exact constructor-private store recognition. */
export function listEntriesForExport(
  opaqueRoomStoreKey: object,
  roomId: string,
  opts: { afterSeq: number; limit: number }
): RoomEntry[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  if (opts.limit <= 0) return [];
  const rows = facet.db
    .select()
    .from(roomEntries)
    .where(
      and(
        eq(roomEntries.roomId, roomId),
        facet.afterTimelineEntry(roomId, opts.afterSeq),
        facet.timelineScope(roomId)
      )
    )
    .orderBy(...facet.timelineOrder(roomId, 'asc'))
    .limit(opts.limit)
    .all();
  return rows.map(toEntry);
}

/** Original getEntryById responsibility after exact constructor-private store recognition. */
export function getEntryById(
  opaqueRoomStoreKey: object,
  roomId: string,
  entryId: string
): RoomEntry | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db
    .select()
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.id, entryId)))
    .get();
  return row ? toEntry(row) : null;
}

/** Original commitAnnouncements responsibility after exact constructor-private store recognition. */
export function commitAnnouncements(
  opaqueRoomStoreKey: object,
  roomId: string,
  shas: readonly string[]
): Map<string, { kind: 'merge' | 'person'; subjectAuthorId: string | null }> {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const found = new Map<string, { kind: 'merge' | 'person'; subjectAuthorId: string | null }>();
  if (shas.length === 0) return found;
  const wanted = [...shas];
  const rows = facet.db
    .select({ body: roomEntries.body })
    .from(roomEntries)
    .where(
      and(
        eq(roomEntries.roomId, roomId),
        or(
          inArray(sql`json_extract(${roomEntries.body}, '$.merge.commit')`, wanted),
          inArray(sql`json_extract(${roomEntries.body}, '$.fileChange.commit')`, wanted)
        )
      )
    )
    .all();
  for (const row of rows) {
    let body: RoomEntryBody;
    try {
      body = JSON.parse(row.body) as RoomEntryBody;
    } catch {
      continue;
    }
    const subjectAuthorId = body.subjectAuthorId ?? null;
    const merged = body.merge?.commit;
    if (merged && wanted.includes(merged)) found.set(merged, { kind: 'merge', subjectAuthorId });
    const changed = body.fileChange?.commit;
    if (changed && wanted.includes(changed)) {
      found.set(changed, { kind: 'person', subjectAuthorId });
    }
  }
  return found;
}

/** Original hasMoment responsibility after exact constructor-private store recognition. */
export function hasMoment(
  opaqueRoomStoreKey: object,
  roomId: string,
  key: { kind: RoomMomentKind; ref?: string; observedAt?: string }
): boolean {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const conditions = [
    eq(roomEntries.roomId, roomId),
    sql`json_extract(${roomEntries.body}, '$.moment.kind') = ${key.kind}`,
  ];
  if (key.ref !== undefined) {
    conditions.push(sql`json_extract(${roomEntries.body}, '$.moment.source.ref') = ${key.ref}`);
  }
  if (key.observedAt !== undefined) {
    conditions.push(
      sql`json_extract(${roomEntries.body}, '$.moment.source.observedAt') = ${key.observedAt}`
    );
  }
  return (
    facet.db
      .select({ seq: roomEntries.seq })
      .from(roomEntries)
      .where(and(...conditions))
      .limit(1)
      .get() !== undefined
  );
}

/** Original latestMomentAt responsibility after exact constructor-private store recognition. */
export function latestMomentAt(
  opaqueRoomStoreKey: object,
  roomId: string,
  scan: number
): string | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  if (scan <= 0) return null;
  const rows = facet.db
    .select({ createdAt: roomEntries.createdAt, body: roomEntries.body })
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId), facet.timelineScope(roomId)))
    .orderBy(...facet.timelineOrder(roomId, 'desc'))
    .limit(scan)
    .all();
  for (const row of rows) {
    if (parseEntryBody(row.body).moment) return row.createdAt;
  }
  return null;
}

/** Original maxSeq responsibility after exact constructor-private store recognition. */
export function maxSeq(opaqueRoomStoreKey: object, roomId: string): number {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db
    .select({ value: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0)` })
    .from(roomEntries)
    .where(eq(roomEntries.roomId, roomId))
    .get();
  return row?.value ?? 0;
}

/** Original countUnread responsibility after exact constructor-private store recognition. */
export function countUnread(
  opaqueRoomStoreKey: object,
  roomId: string,
  lastReadSeq: number
): number {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db
    .select({ value: count() })
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId), gt(roomEntries.seq, lastReadSeq)))
    .get();
  return row?.value ?? 0;
}

/** Original countThreadReplies responsibility after exact constructor-private store recognition. */
export function countThreadReplies(
  opaqueRoomStoreKey: object,
  roomId: string,
  threadRootEntryId: string
): number {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db
    .select({ value: count() })
    .from(roomEntries)
    .where(
      and(eq(roomEntries.roomId, roomId), eq(roomEntries.threadRootEntryId, threadRootEntryId))
    )
    .get();
  return row?.value ?? 0;
}

/** Original turnsByAuthorInCascade responsibility after exact constructor-private store recognition. */
export function turnsByAuthorInCascade(
  opaqueRoomStoreKey: object,
  roomId: string,
  cascadeRoot: string
): Map<string, number> {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const rows = facet.db
    .select({
      authorId: roomEntries.authorId,
      // `IS NULL` yields 1/0 in SQLite, so the second half needs no CASE.
      turns: sql<number>`COUNT(DISTINCT ${roomEntries.dispatchId})
          + SUM(${roomEntries.dispatchId} IS NULL)`,
    })
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.cascadeRoot, cascadeRoot)))
    .groupBy(roomEntries.authorId)
    .all();
  return new Map(rows.map((row) => [row.authorId, row.turns]));
}
