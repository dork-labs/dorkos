/**
 * Mirror lifecycle writes for the remote community mirror: refreshing a mirror's read grants,
 * forgetting a purged mapping, and deleting what a revoked mirror held.
 *
 * @module services/communities/remote/mirror-store/lifecycle
 */
import {
  and,
  communityMirrorAccess,
  communityMirrorEntries,
  communityMirrorRedactions,
  communityRoomMirrors,
  eq,
  inArray,
  readCursors,
  roomAttachments,
  roomEntries,
  roomMembers,
  roomSessions,
  rooms,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { deleteRoomNotifications } from '../../../notifications/room-entry-notifications.js';
import { dedupeAccessors } from './rows.js';
import type { MirrorPurge, MirrorRoomInput } from './types.js';

/**
 * Delete what a revoked mirror held, down to its local room: entries (their reactions cascade),
 * files, members, agent sessions, read positions, inbox notifications about it, cached remote
 * entries, and remembered changes. A revoked mirror is unreadable here and no longer reads the redaction feed, so a
 * later deletion, removal, or erasure on the server could never reach its copy; keeping none
 * is the only way that copy cannot outlive one. The mapping row stays, revoked, so a late
 * stream frame cannot recreate the room; readmission gives it a fresh local room
 * (`RemoteMirrorStore.ensureRoom`). A room already deleted is skipped.
 *
 * @param tx - The open transaction the purge runs in.
 */
export function purgeContent(
  tx: DbTransaction,
  communityRef: CommunityRef,
  mirrored: readonly { localRoomId: string; remoteRoomId: string }[]
): MirrorPurge {
  const present = mirrored.filter(
    (room) =>
      tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, room.localRoomId)).get() !==
      undefined
  );
  const localRoomIds = present.map((room) => room.localRoomId);
  if (!localRoomIds.length) return { localRoomIds, attachments: [] };
  const attachments = tx
    .select({
      roomId: roomAttachments.roomId,
      attachmentId: roomAttachments.id,
      extension: roomAttachments.extension,
    })
    .from(roomAttachments)
    .where(inArray(roomAttachments.roomId, localRoomIds))
    .all();
  tx.delete(roomAttachments).where(inArray(roomAttachments.roomId, localRoomIds)).run();
  tx.delete(roomEntries).where(inArray(roomEntries.roomId, localRoomIds)).run();
  tx.delete(roomMembers).where(inArray(roomMembers.roomId, localRoomIds)).run();
  tx.delete(roomSessions).where(inArray(roomSessions.roomId, localRoomIds)).run();
  tx.delete(readCursors)
    .where(and(eq(readCursors.threadKind, 'room'), inArray(readCursors.threadId, localRoomIds)))
    .run();
  tx.delete(rooms).where(inArray(rooms.id, localRoomIds)).run();
  deleteRoomNotifications(tx, localRoomIds);
  tx.delete(communityMirrorEntries)
    .where(inArray(communityMirrorEntries.localRoomId, localRoomIds))
    .run();
  tx.delete(communityMirrorRedactions)
    .where(
      and(
        eq(communityMirrorRedactions.communityRef, communityRef),
        inArray(
          communityMirrorRedactions.remoteRoomId,
          present.map((room) => room.remoteRoomId)
        )
      )
    )
    .run();
  tx.update(communityRoomMirrors)
    .set({ redactionCursor: null })
    .where(inArray(communityRoomMirrors.localRoomId, localRoomIds))
    .run();
  return { localRoomIds, attachments };
}

/**
 * Drop a mapping whose local room was purged, so readmission can create a fresh one.
 *
 * @param db - The database the mirror lives in.
 */
export function forgetMapping(db: Db, localRoomId: string): undefined {
  db.transaction((tx) => {
    tx.delete(communityMirrorAccess)
      .where(eq(communityMirrorAccess.localRoomId, localRoomId))
      .run();
    tx.delete(communityRoomMirrors).where(eq(communityRoomMirrors.localRoomId, localRoomId)).run();
  });
  return undefined;
}

/**
 * Re-authorize a mirror for its owner and accessors, and revoke every grant no longer listed.
 *
 * @param db - The database the mirror lives in.
 */
export function refreshAccess(db: Db, localRoomId: string, input: MirrorRoomInput): void {
  const accessors = dedupeAccessors(input.ownerAuthorId, input.accessors);
  db.transaction((tx) => {
    tx.update(communityRoomMirrors)
      .set({
        ownerAuthorId: input.ownerAuthorId,
        state: 'authorized',
        authorizedAt: input.authorizedAt,
      })
      .where(eq(communityRoomMirrors.localRoomId, localRoomId))
      .run();
    for (const accessor of accessors) {
      tx.insert(communityMirrorAccess)
        .values({ localRoomId, authorId: accessor.authorId, state: 'authorized' })
        .onConflictDoUpdate({
          target: [communityMirrorAccess.localRoomId, communityMirrorAccess.authorId],
          set: { state: 'authorized' },
        })
        .run();
      tx.insert(roomMembers)
        .values({
          roomId: localRoomId,
          authorId: accessor.authorId,
          responseMode: accessor.responseMode ?? 'silent',
          joinedAt: input.authorizedAt,
          joinedSeq: 0,
          lastReadSeq: 0,
        })
        .onConflictDoNothing()
        .run();
    }
    const permitted = new Set(accessors.map((accessor) => accessor.authorId));
    const existing = tx
      .select({ authorId: communityMirrorAccess.authorId })
      .from(communityMirrorAccess)
      .where(eq(communityMirrorAccess.localRoomId, localRoomId))
      .all();
    for (const row of existing) {
      if (permitted.has(row.authorId)) continue;
      tx.update(communityMirrorAccess)
        .set({ state: 'revoked' })
        .where(
          and(
            eq(communityMirrorAccess.localRoomId, localRoomId),
            eq(communityMirrorAccess.authorId, row.authorId)
          )
        )
        .run();
    }
  });
}
