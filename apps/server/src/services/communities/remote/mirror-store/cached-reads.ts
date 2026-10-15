/**
 * Owner-only reads of the remote community mirror's cache: cached entries in their opaque
 * adapter shape, with native author metadata, in remote order, and the connections that still
 * have mirrored content.
 *
 * @module services/communities/remote/mirror-store/cached-reads
 */
import {
  and,
  communityMirrorEntries,
  communityRoomMirrors,
  eq,
  gt,
  rooms,
  type Db,
} from '@dorkos/db';
import {
  CommunityEntrySchema,
  type CommunityEntry,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import { findMirror, toCachedEntry } from './rows.js';
import type { CachedRemoteEntry } from './types.js';

/**
 * The body of `RemoteMirrorStore.cachedEntryForOwner`: one cached entry in its opaque adapter
 * shape, for the mirror's owner only.
 *
 * @param db - The database the mirror lives in.
 */
export function cachedEntryIn(
  db: Db,
  communityRef: CommunityRef,
  remoteRoomId: string,
  remoteEntryId: string,
  ownerAuthorId: string
): CommunityEntry | null {
  const mirror = findMirror(db, communityRef, remoteRoomId);
  if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked') return null;
  const row = db
    .select({ entryJson: communityMirrorEntries.entryJson })
    .from(communityMirrorEntries)
    .where(
      and(
        eq(communityMirrorEntries.communityRef, communityRef),
        eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
        eq(communityMirrorEntries.remoteEntryId, remoteEntryId)
      )
    )
    .get();
  return row?.entryJson ? CommunityEntrySchema.parse(JSON.parse(row.entryJson)) : null;
}

/**
 * The body of `RemoteMirrorStore.cachedEntryWithAuthorForOwner`: one cached entry with its
 * native author metadata, for the mirror's owner only.
 *
 * @param db - The database the mirror lives in.
 */
export function cachedEntryWithAuthorIn(
  db: Db,
  communityRef: CommunityRef,
  remoteRoomId: string,
  remoteEntryId: string,
  ownerAuthorId: string
): CachedRemoteEntry | null {
  const mirror = findMirror(db, communityRef, remoteRoomId);
  if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked') return null;
  const row = db
    .select({
      entryJson: communityMirrorEntries.entryJson,
      remoteSeq: communityMirrorEntries.remoteSeq,
      authorDisplayName: communityMirrorEntries.authorDisplayName,
      authorKind: communityMirrorEntries.authorKind,
    })
    .from(communityMirrorEntries)
    .where(
      and(
        eq(communityMirrorEntries.communityRef, communityRef),
        eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
        eq(communityMirrorEntries.remoteEntryId, remoteEntryId)
      )
    )
    .get();
  return row ? toCachedEntry(row) : null;
}

/**
 * The body of `RemoteMirrorStore.cachedEntriesForOwner`: a page of cached entries in native
 * remote order, for the mirror's owner only.
 *
 * @param db - The database the mirror lives in.
 */
export function cachedEntriesIn(
  db: Db,
  communityRef: CommunityRef,
  remoteRoomId: string,
  ownerAuthorId: string,
  opts: { afterRemoteSeq?: number; limit: number }
): readonly CommunityEntry[] {
  const mirror = findMirror(db, communityRef, remoteRoomId);
  if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked') return [];
  const limit = Math.min(Math.max(0, opts.limit), 200);
  if (limit === 0) return [];
  return (
    db
      .select({ entryJson: communityMirrorEntries.entryJson })
      .from(communityMirrorEntries)
      // The mirror's local room names the same rows as (communityRef, remoteRoomId), one
      // to one, and it is what `(local_room_id, remote_seq)` is keyed by: with it the page
      // is read in order from the index; without it every cached entry of the room was
      // read and sorted to return 200 (0.55 ms to 0.09 ms at 2,000 entries, growing with
      // the room).
      .where(
        and(
          eq(communityMirrorEntries.communityRef, communityRef),
          eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
          eq(communityMirrorEntries.localRoomId, mirror.localRoomId),
          ...(opts.afterRemoteSeq === undefined
            ? []
            : [gt(communityMirrorEntries.remoteSeq, opts.afterRemoteSeq)])
        )
      )
      .orderBy(communityMirrorEntries.remoteSeq)
      .limit(limit)
      .all()
      // Older rows predate opaque projection storage and are refreshed from the
      // remote adapter rather than pretending an incomplete value is complete.
      .flatMap((row) =>
        row.entryJson ? [CommunityEntrySchema.parse(JSON.parse(row.entryJson))] : []
      )
  );
}

/**
 * The body of `RemoteMirrorStore.mirroredConnections`: every owner connection that still has
 * mirrored content on this machine.
 *
 * @param db - The database the mirror lives in.
 */
export function mirroredConnectionsIn(
  db: Db
): { communityRef: CommunityRef; ownerAuthorId: string }[] {
  const pairs = new Map<string, { communityRef: CommunityRef; ownerAuthorId: string }>();
  for (const row of db
    .select({
      communityRef: communityRoomMirrors.communityRef,
      ownerAuthorId: communityRoomMirrors.ownerAuthorId,
      state: communityRoomMirrors.state,
      room: rooms.id,
    })
    .from(communityRoomMirrors)
    .leftJoin(rooms, eq(rooms.id, communityRoomMirrors.localRoomId))
    .all()) {
    if (row.state === 'revoked' && row.room === null) continue;
    const communityRef = row.communityRef as CommunityRef;
    pairs.set(`${communityRef}\0${row.ownerAuthorId}`, {
      communityRef,
      ownerAuthorId: row.ownerAuthorId,
    });
  }
  return [...pairs.values()];
}
