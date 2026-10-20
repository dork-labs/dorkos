/**
 * The import half of the remote community mirror: storing a page of native entries in remote
 * sequence order, in one write transaction, without dispatching, publishing or indexing.
 *
 * @module services/communities/remote/mirror-store/entry-import
 */
import { ulid } from 'ulidx';
import {
  and,
  communityMirrorEntries,
  communityMirrorRedactions,
  eq,
  inArray,
  isNull,
  roomEntries,
  roomMembers,
  rooms,
  sql,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { CommunityEntrySchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';
import { toEntry } from '../../../rooms/room-rows.js';
import { isNativeAuthorKind } from './rows.js';
import type { NativeMirrorEntry } from './types.js';

/**
 * Validate, resolve and store one page of native entries for a live mirror. The body of
 * `RemoteMirrorStore.importEntries` after its mirror lookup.
 *
 * @param db - The database the mirror lives in.
 * @param authors - Resolves each remote author to a local external author.
 * @param mirror - The live (not revoked) mirror the page lands in.
 * @param communityRef - The community the page came from.
 * @param remoteRoomId - The remote room the page came from.
 * @param entries - The page, in any order.
 */
export function importMirrorEntries(
  db: Db,
  authors: AuthorRegistry,
  mirror: { localRoomId: string },
  communityRef: CommunityRef,
  remoteRoomId: string,
  entries: readonly NativeMirrorEntry[]
): RoomEntry[] {
  const ordered = [...entries].sort((a, b) => a.remoteSeq - b.remoteSeq);
  // The whole page is checked before anything is written: it is stored in one transaction, so
  // a bad entry refuses the page rather than leaving part of it cached.
  for (const item of ordered) {
    if (!Number.isSafeInteger(item.remoteSeq) || item.remoteSeq <= 0) {
      throw new Error('A native community entry needs a positive integer sequence');
    }
    if (item.entry.community !== communityRef || item.entry.roomId !== remoteRoomId) {
      throw new Error('A native community entry does not belong to this mirror');
    }
  }
  // A change the redaction feed reported before an entry was cached wins over the frame, which
  // may have been read before the change. Resolved before the write transaction, as the author
  // registry writes on its own.
  const items = ordered.map((frame) => {
    const item = withKnownRedaction(db, communityRef, remoteRoomId, frame);
    const external = authors.resolveExternal({
      platformType: 'community',
      instanceId: communityRef,
      platformUserId: item.author.memberId,
      displayName: item.author.displayName,
    });
    return { item, authorId: external.id };
  });
  if (!items.length) return [];
  // One transaction per page, and every statement in it an index lookup: the cost of a page
  // no longer grows with the room it lands in (DOR-2573).
  return db.transaction(
    (tx) => {
      const imported: RoomEntry[] = [];
      let nextSeq: number | null = null;
      let newest: string | null = null;
      for (const { item, authorId } of items) {
        const existing = tx
          .select({ localEntryId: communityMirrorEntries.localEntryId })
          .from(communityMirrorEntries)
          .where(
            and(
              eq(communityMirrorEntries.communityRef, communityRef),
              eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
              eq(communityMirrorEntries.remoteEntryId, item.entry.id)
            )
          )
          .get();
        if (existing) {
          const row = localRow(tx, mirror.localRoomId, existing.localEntryId);
          if (row) imported.push(row);
          continue;
        }
        nextSeq ??= nextLocalSeq(tx, mirror.localRoomId);
        const saved = insertEntry(tx, mirror.localRoomId, communityRef, remoteRoomId, {
          item,
          authorId,
          localSeq: nextSeq,
        });
        nextSeq += 1;
        if (newest === null || item.entry.createdAt > newest) newest = item.entry.createdAt;
        if (saved) imported.push(saved);
      }
      if (newest !== null) {
        tx.update(rooms)
          // A late history page may be older than the snapshot already cached.
          // Keep the newest server timestamp only for sidebar activity; remote
          // sequence remains the authoritative order everywhere else.
          .set({
            lastActivityAt: sql`CASE WHEN ${rooms.lastActivityAt} > ${newest} THEN ${rooms.lastActivityAt} ELSE ${newest} END`,
          })
          .where(eq(rooms.id, mirror.localRoomId))
          .run();
      }
      return imported;
    },
    { behavior: 'immediate' }
  );
}

/** The local room log's next `seq`, read once per page inside its write transaction. */
function nextLocalSeq(tx: DbTransaction, localRoomId: string): number {
  const allocated = tx
    .select({ next: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0) + 1` })
    .from(roomEntries)
    .where(eq(roomEntries.roomId, localRoomId))
    .get();
  return allocated?.next ?? 1;
}

/** One local room entry as the room store returns it. */
function localRow(tx: DbTransaction, localRoomId: string, localEntryId: string): RoomEntry | null {
  const row = tx
    .select()
    .from(roomEntries)
    .where(and(eq(roomEntries.roomId, localRoomId), eq(roomEntries.id, localEntryId)))
    .get();
  return row ? toEntry(row) : null;
}

/**
 * Store one entry not cached yet: its room log row, its cache row, and the links of any reply
 * that arrived before it.
 */
function insertEntry(
  tx: DbTransaction,
  localRoomId: string,
  communityRef: CommunityRef,
  remoteRoomId: string,
  { item, authorId, localSeq }: { item: NativeMirrorEntry; authorId: string; localSeq: number }
): RoomEntry | null {
  const colliding = tx
    .select({ remoteEntryId: communityMirrorEntries.remoteEntryId })
    .from(communityMirrorEntries)
    .where(
      and(
        eq(communityMirrorEntries.localRoomId, localRoomId),
        eq(communityMirrorEntries.remoteSeq, item.remoteSeq)
      )
    )
    .get();
  if (colliding) throw new Error('Two remote entries cannot share a remote sequence');

  const parentEntryId = localEntryIdFor(tx, communityRef, remoteRoomId, item.entry.parentEntryId);
  const threadRootEntryId = localEntryIdFor(
    tx,
    communityRef,
    remoteRoomId,
    item.entry.threadRootEntryId
  );
  const localEntryId = ulid();
  tx.insert(roomMembers)
    .values({
      roomId: localRoomId,
      authorId,
      responseMode: 'silent',
      joinedAt: item.entry.createdAt,
      joinedSeq: 0,
      lastReadSeq: 0,
    })
    .onConflictDoNothing()
    .run();
  tx.insert(roomEntries)
    .values({
      roomId: localRoomId,
      seq: localSeq,
      // Remote history reads in the Community's order (`room_entries.timeline_band`).
      timelineBand: 0,
      timelinePos: item.remoteSeq,
      id: localEntryId,
      authorId,
      kind: 'post',
      body: JSON.stringify({ text: item.entry.text }),
      mentions: JSON.stringify(item.entry.mentions),
      mentionSpans: '[]',
      sessionId: null,
      cascadeRoot: localEntryId,
      cascadeDepth: 0,
      dispatchId: null,
      parentEntryId,
      threadRootEntryId,
      signature: null,
      createdAt: item.entry.createdAt,
    })
    .run();
  tx.delete(communityMirrorRedactions)
    .where(
      and(
        eq(communityMirrorRedactions.communityRef, communityRef),
        eq(communityMirrorRedactions.remoteRoomId, remoteRoomId),
        eq(communityMirrorRedactions.remoteEntryId, item.entry.id)
      )
    )
    .run();
  tx.insert(communityMirrorEntries)
    .values({
      communityRef,
      remoteRoomId,
      remoteEntryId: item.entry.id,
      localRoomId,
      localEntryId,
      remoteSeq: item.remoteSeq,
      entryJson: JSON.stringify(CommunityEntrySchema.parse(item.entry)),
      authorDisplayName: item.author.displayName,
      authorKind: item.author.kind,
      remoteParentEntryId: item.entry.parentEntryId,
      remoteThreadRootEntryId: item.entry.threadRootEntryId,
    })
    .run();
  linkWaitingReplies(tx, localRoomId, item.entry.id, localEntryId);
  return localRow(tx, localRoomId, localEntryId);
}

/** The entry as the redaction feed last reported it, when it changed before it was cached. */
function withKnownRedaction(
  db: Db,
  communityRef: CommunityRef,
  remoteRoomId: string,
  item: NativeMirrorEntry
): NativeMirrorEntry {
  const known = db
    .select()
    .from(communityMirrorRedactions)
    .where(
      and(
        eq(communityMirrorRedactions.communityRef, communityRef),
        eq(communityMirrorRedactions.remoteRoomId, remoteRoomId),
        eq(communityMirrorRedactions.remoteEntryId, item.entry.id)
      )
    )
    .get();
  if (!known || !isNativeAuthorKind(known.authorKind)) return item;
  return {
    entry: CommunityEntrySchema.parse(JSON.parse(known.entryJson)),
    remoteSeq: item.remoteSeq,
    author: {
      memberId: item.author.memberId,
      displayName: known.authorDisplayName,
      kind: known.authorKind,
    },
  };
}

/** The local id of an already cached remote entry, or `null` when it is not cached (yet). */
function localEntryIdFor(
  tx: Db | DbTransaction,
  communityRef: CommunityRef,
  remoteRoomId: string,
  remoteEntryId: string | null
): string | null {
  if (remoteEntryId === null) return null;
  return (
    tx
      .select({ localEntryId: communityMirrorEntries.localEntryId })
      .from(communityMirrorEntries)
      .where(
        and(
          eq(communityMirrorEntries.communityRef, communityRef),
          eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
          eq(communityMirrorEntries.remoteEntryId, remoteEntryId)
        )
      )
      .get()?.localEntryId ?? null
  );
}

/**
 * Link the replies cached before the entry they answer, now that it has arrived.
 *
 * A history page read backwards brings replies before their parents, so a reply is stored
 * with no local parent and linked here, when its parent lands. Only the replies that name this
 * entry are touched, found through their stored Community relation; this once re-read every
 * cached entry of the room on every import, which made filling a room quadratic (DOR-2573).
 */
function linkWaitingReplies(
  tx: DbTransaction,
  localRoomId: string,
  remoteEntryId: string,
  localEntryId: string
): void {
  const waiting = (
    relation:
      | typeof communityMirrorEntries.remoteParentEntryId
      | typeof communityMirrorEntries.remoteThreadRootEntryId
  ) =>
    tx
      .select({ localEntryId: communityMirrorEntries.localEntryId })
      .from(communityMirrorEntries)
      .where(and(eq(communityMirrorEntries.localRoomId, localRoomId), eq(relation, remoteEntryId)));
  tx.update(roomEntries)
    .set({ parentEntryId: localEntryId })
    .where(
      and(
        eq(roomEntries.roomId, localRoomId),
        inArray(roomEntries.id, waiting(communityMirrorEntries.remoteParentEntryId))
      )
    )
    .run();
  tx.update(roomEntries)
    .set({ threadRootEntryId: localEntryId })
    .where(
      and(
        eq(roomEntries.roomId, localRoomId),
        inArray(roomEntries.id, waiting(communityMirrorEntries.remoteThreadRootEntryId))
      )
    )
    .run();
}

/**
 * The body of `RemoteMirrorStore.claimRemoteDispatch`: atomically claim the one local dispatch
 * of an imported remote entry.
 *
 * @param db - The database the mirror lives in.
 */
export function claimRemoteDispatchIn(
  db: Db,
  communityRef: CommunityRef,
  remoteRoomId: string,
  remoteEntryId: string,
  claimedAt: string
): boolean {
  const result = db
    .update(communityMirrorEntries)
    .set({ dispatchClaimedAt: claimedAt })
    .where(
      and(
        eq(communityMirrorEntries.communityRef, communityRef),
        eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
        eq(communityMirrorEntries.remoteEntryId, remoteEntryId),
        isNull(communityMirrorEntries.dispatchClaimedAt)
      )
    )
    .run();
  return result.changes === 1;
}
