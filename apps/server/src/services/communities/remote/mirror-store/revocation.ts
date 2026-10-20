/**
 * Revocation writes for the remote community mirror: marking an owner's mirrors stale or
 * revoked, and withdrawing one agent's grants and memberships.
 *
 * @module services/communities/remote/mirror-store/revocation
 */
import {
  and,
  communityMirrorAccess,
  communityRoomMirrors,
  eq,
  roomMembers,
  type Db,
} from '@dorkos/db';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { RevokedRemoteMirrorRoom } from './types.js';

/**
 * The body of `RemoteMirrorStore.markStale`: mark one owner's authorized mirrors stale.
 *
 * @param db - The database the mirror lives in.
 */
export function markStaleIn(db: Db, communityRef: CommunityRef, ownerAuthorId: string): void {
  db.update(communityRoomMirrors)
    .set({ state: 'stale' })
    .where(
      and(
        eq(communityRoomMirrors.communityRef, communityRef),
        eq(communityRoomMirrors.ownerAuthorId, ownerAuthorId),
        eq(communityRoomMirrors.state, 'authorized')
      )
    )
    .run();
}

/**
 * The body of `RemoteMirrorStore.revoke`: revoke one owner's mirrors of a community and their
 * read grants, in one transaction.
 *
 * @param db - The database the mirror lives in.
 */
export function revokeOwnerMirrors(
  db: Db,
  communityRef: CommunityRef,
  ownerAuthorId: string
): void {
  db.transaction((tx) => {
    const owned = and(
      eq(communityRoomMirrors.communityRef, communityRef),
      eq(communityRoomMirrors.ownerAuthorId, ownerAuthorId)
    );
    const mirrored = tx
      .select({
        localRoomId: communityRoomMirrors.localRoomId,
        remoteRoomId: communityRoomMirrors.remoteRoomId,
      })
      .from(communityRoomMirrors)
      .where(owned)
      .all();
    tx.update(communityRoomMirrors).set({ state: 'revoked' }).where(owned).run();
    for (const row of mirrored) {
      tx.update(communityMirrorAccess)
        .set({ state: 'revoked' })
        .where(eq(communityMirrorAccess.localRoomId, row.localRoomId))
        .run();
    }
  });
}

/**
 * The body of `RemoteMirrorStore.revokeAbsentRooms`: revoke every mirror absent from a
 * complete directory read, in one transaction, and return what was revoked.
 *
 * @param db - The database the mirror lives in.
 */
export function revokeAbsentMirrors(
  db: Db,
  communityRef: CommunityRef,
  ownerAuthorId: string,
  allowedRemoteRoomIds: ReadonlySet<string>
): readonly RevokedRemoteMirrorRoom[] {
  return db.transaction((tx) => {
    const absent = tx
      .select({
        localRoomId: communityRoomMirrors.localRoomId,
        remoteRoomId: communityRoomMirrors.remoteRoomId,
        state: communityRoomMirrors.state,
      })
      .from(communityRoomMirrors)
      .where(
        and(
          eq(communityRoomMirrors.communityRef, communityRef),
          eq(communityRoomMirrors.ownerAuthorId, ownerAuthorId)
        )
      )
      .all()
      .filter((row) => row.state !== 'revoked' && !allowedRemoteRoomIds.has(row.remoteRoomId));
    for (const room of absent) {
      tx.update(communityRoomMirrors)
        .set({ state: 'revoked' })
        .where(eq(communityRoomMirrors.localRoomId, room.localRoomId))
        .run();
      tx.update(communityMirrorAccess)
        .set({ state: 'revoked' })
        .where(eq(communityMirrorAccess.localRoomId, room.localRoomId))
        .run();
    }
    return absent;
  });
}

/**
 * The body of `RemoteMirrorStore.revokeAgentAccess`: revoke one local agent's grants on every
 * mirror of one owner's connection.
 *
 * @param db - The database the mirror lives in.
 */
export function revokeAgentAccessIn(
  db: Db,
  communityRef: CommunityRef,
  ownerAuthorId: string,
  authorId: string
): void {
  const rooms = db
    .select({ localRoomId: communityRoomMirrors.localRoomId })
    .from(communityRoomMirrors)
    .where(
      and(
        eq(communityRoomMirrors.communityRef, communityRef),
        eq(communityRoomMirrors.ownerAuthorId, ownerAuthorId)
      )
    )
    .all();
  db.transaction((tx) => {
    for (const room of rooms) {
      tx.update(communityMirrorAccess)
        .set({ state: 'revoked' })
        .where(
          and(
            eq(communityMirrorAccess.localRoomId, room.localRoomId),
            eq(communityMirrorAccess.authorId, authorId)
          )
        )
        .run();
    }
  });
}

/**
 * The body of `RemoteMirrorStore.removeAgentMembership`: remove one agent from every mirrored
 * local room of one owner's connection.
 *
 * @param db - The database the mirror lives in.
 */
export function removeAgentMembershipIn(
  db: Db,
  communityRef: CommunityRef,
  ownerAuthorId: string,
  authorId: string
): void {
  const rooms = db
    .select({ localRoomId: communityRoomMirrors.localRoomId })
    .from(communityRoomMirrors)
    .where(
      and(
        eq(communityRoomMirrors.communityRef, communityRef),
        eq(communityRoomMirrors.ownerAuthorId, ownerAuthorId)
      )
    )
    .all();
  db.transaction((tx) => {
    for (const room of rooms) {
      tx.delete(roomMembers)
        .where(and(eq(roomMembers.roomId, room.localRoomId), eq(roomMembers.authorId, authorId)))
        .run();
    }
  });
}
