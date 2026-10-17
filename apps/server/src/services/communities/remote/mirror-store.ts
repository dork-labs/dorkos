/**
 * Persisted local cache for one connected community's authorized rooms.
 *
 * Imports deliberately write the room tables without going through
 * `RoomEntryWriter`: a snapshot or history page is durable remote history, not
 * a local post and never a reason to dispatch a local agent.
 *
 * @module services/communities/remote/mirror-store
 */
import { ulid } from 'ulidx';
import {
  and,
  communityMirrorAccess,
  communityMirrorEntries,
  communityRoomMirrors,
  eq,
  roomAttachments,
  roomMembers,
  rooms,
  type Db,
} from '@dorkos/db';
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import type { RoomStore } from '../../rooms/room-store.js';
import { claimRemoteDispatchIn, importMirrorEntries } from './mirror-store/entry-import.js';
import { forgetMapping, purgeContent, refreshAccess } from './mirror-store/lifecycle.js';
import {
  applyRedactionPage,
  attachmentsNeedingChecksumIn,
  plannedAttachmentDropsIn,
  resetRedactionCursorIn,
} from './mirror-store/redactions.js';
import {
  cachedEntriesIn,
  cachedEntryIn,
  cachedEntryWithAuthorIn,
  mirroredConnectionsIn,
} from './mirror-store/cached-reads.js';
import {
  markStaleIn,
  removeAgentMembershipIn,
  revokeAbsentMirrors,
  revokeAgentAccessIn,
  revokeOwnerMirrors,
} from './mirror-store/revocation.js';
import { dedupeAccessors, findMirror } from './mirror-store/rows.js';
import type {
  AppliedRedactions,
  CachedRemoteEntry,
  MirrorAttachmentFile,
  MirrorPurge,
  MirrorRoomAccess,
  MirrorRoomInput,
  NativeMirrorEntry,
  RevokedRemoteMirrorRoom,
} from './mirror-store/types.js';

// The value shapes live in ./mirror-store/types; every name stays importable from here.
export type {
  AppliedRedactions,
  CachedRemoteEntry,
  MirrorAccessor,
  MirrorAttachmentFile,
  MirrorPurge,
  MirrorRoomAccess,
  MirrorRoomInput,
  MirrorState,
  NativeMirrorEntry,
  RevokedRemoteMirrorRoom,
} from './mirror-store/types.js';

/**
 * The local SQLite half of a remote community mirror.
 *
 * The generic adapter intentionally does not expose a comparable sequence. The
 * native adapter supplies it through a private projection, and this store is
 * the only consumer that persists it. It never inspects a cursor or timestamp
 * to infer order.
 */
export class RemoteMirrorStore implements MirrorRoomAccess {
  /**
   * Open the mirror half of the room tables.
   *
   * @param purged - Told, after the transaction, which rooms a revocation emptied, so the
   *   search index and file store can drop them too.
   */
  constructor(
    private readonly db: Db,
    private readonly roomsStore: RoomStore,
    private readonly authors: AuthorRegistry,
    private readonly purged?: (purge: MirrorPurge) => void
  ) {
    // A RoomStore is shared with ordinary rooms, whose hot reads must stay on
    // their `(room_id, seq)` indexes. Restore the persisted remote-room set
    // when this mirror facade is recreated so a late history page cannot make
    // a restarted process fall back to local insertion order.
    for (const row of this.db
      .select({ localRoomId: communityRoomMirrors.localRoomId })
      .from(communityRoomMirrors)
      .all()) {
      this.roomsStore.registerRemoteTimelineRoom(row.localRoomId);
    }
  }

  /** Create or refresh one authorized mirror and its local read grants. */
  ensureRoom(input: MirrorRoomInput): Room {
    const found = this.findRoom(input.communityRef, input.remoteRoomId);
    // A revoked mirror's local room was deleted with its content. Readmission starts a fresh
    // room with a fresh id, so no reader resumes from a position in the old one.
    const existing =
      found && !this.roomsStore.getRoom(found.localRoomId)
        ? forgetMapping(this.db, found.localRoomId)
        : found;
    if (existing) {
      refreshAccess(this.db, existing.localRoomId, input);
      const room = this.roomsStore.getRoom(existing.localRoomId);
      if (!room) throw new Error('A community mirror mapping points to a missing local room');
      this.roomsStore.registerRemoteTimelineRoom(existing.localRoomId);
      return room;
    }

    const accessors = dedupeAccessors(input.ownerAuthorId, input.accessors);
    const createdAt = input.authorizedAt;
    const localRoomId = ulid();
    try {
      const room = this.roomsStore.createRoom(
        {
          id: localRoomId,
          kind: 'channel',
          slug: null,
          title: input.title,
          topic: input.topic,
          createdAt,
        },
        accessors.map((accessor) => ({
          authorId: accessor.authorId,
          responseMode: accessor.responseMode ?? 'silent',
          joinedAt: createdAt,
        })),
        (tx) => {
          tx.insert(communityRoomMirrors)
            .values({
              localRoomId,
              communityRef: input.communityRef,
              remoteRoomId: input.remoteRoomId,
              ownerAuthorId: input.ownerAuthorId,
              state: 'authorized',
              authorizedAt: input.authorizedAt,
            })
            .run();
          for (const accessor of accessors) {
            tx.insert(communityMirrorAccess)
              .values({ localRoomId, authorId: accessor.authorId, state: 'authorized' })
              .run();
          }
        }
      );
      this.roomsStore.registerRemoteTimelineRoom(room.id);
      return room;
    } catch (error) {
      // `createRoom`'s callback is transactional. A competing cache import
      // therefore leaves no stray local room; adopt the mapping that won.
      const raced = this.findRoom(input.communityRef, input.remoteRoomId);
      if (!raced) throw error;
      refreshAccess(this.db, raced.localRoomId, input);
      const room = this.roomsStore.getRoom(raced.localRoomId);
      if (!room) throw error;
      this.roomsStore.registerRemoteTimelineRoom(raced.localRoomId);
      return room;
    }
  }

  /**
   * Import native entries idempotently and in remote sequence order.
   *
   * There is intentionally no publish, notifier, index write, or dispatcher in
   * this path. History, snapshots, restart recovery and pagination are cache
   * imports, never live local activity.
   */
  importEntries(
    communityRef: CommunityRef,
    remoteRoomId: string,
    entries: readonly NativeMirrorEntry[]
  ): RoomEntry[] {
    const mirror = this.findRoom(communityRef, remoteRoomId);
    if (!mirror || mirror.state === 'revoked') return [];
    return importMirrorEntries(this.db, this.authors, mirror, communityRef, remoteRoomId, entries);
  }

  /**
   * Atomically claim the one eligible local dispatch for an already imported
   * remote entry.
   *
   * A restart must not make a gap-free reconnect execute an entry twice. This
   * is intentionally a dispatch receipt rather than an outbox or delivery
   * state: the bridge owns only inbound eligibility, while outbound delivery
   * remains the later writer/outbox concern.
   */
  claimRemoteDispatch(
    communityRef: CommunityRef,
    remoteRoomId: string,
    remoteEntryId: string,
    claimedAt: string
  ): boolean {
    return claimRemoteDispatchIn(this.db, communityRef, remoteRoomId, remoteEntryId, claimedAt);
  }

  /**
   * Read one authorized cached entry in its original opaque adapter shape.
   *
   * This projection exists for restart and offline repair paths. It returns no
   * local path, author record, or decoded cursor, and stale cache remains
   * owner-only through the same persisted mirror state as room reads.
   */
  cachedEntryForOwner(
    communityRef: CommunityRef,
    remoteRoomId: string,
    remoteEntryId: string,
    ownerAuthorId: string
  ): CommunityEntry | null {
    return cachedEntryIn(this.db, communityRef, remoteRoomId, remoteEntryId, ownerAuthorId);
  }

  /**
   * Read one cached entry together with native author metadata.
   *
   * The remote route can render this provenance, but it must never turn the
   * author into a local principal or infer authority from its display label.
   */
  cachedEntryWithAuthorForOwner(
    communityRef: CommunityRef,
    remoteRoomId: string,
    remoteEntryId: string,
    ownerAuthorId: string
  ): CachedRemoteEntry | null {
    return cachedEntryWithAuthorIn(
      this.db,
      communityRef,
      remoteRoomId,
      remoteEntryId,
      ownerAuthorId
    );
  }

  /**
   * Read all authorized cached entries in native remote order.
   *
   * The entries remain full generic adapter values: cursors, attachment metadata
   * and remote thread identities are opaque to this cache. Callers can page or
   * filter them without deriving order from timestamps or local storage ordinals.
   */
  cachedEntriesForOwner(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    opts: { afterRemoteSeq?: number; limit: number }
  ): readonly CommunityEntry[] {
    return cachedEntriesIn(this.db, communityRef, remoteRoomId, ownerAuthorId, opts);
  }

  /**
   * Where this mirror last read the remote channel's redaction feed.
   *
   * @returns `null` when there is no mirror or it was revoked (a departed member's cache is not
   *   refreshed); otherwise the stored cursor, `null` before the first read.
   */
  redactionCursor(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string
  ): { cursor: string | null } | null {
    const mirror = this.findRoom(communityRef, remoteRoomId);
    if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked')
      return null;
    return { cursor: mirror.redactionCursor };
  }

  /** Forget the redaction feed position, so the next read starts from the beginning. */
  resetRedactionCursor(communityRef: CommunityRef, remoteRoomId: string): void {
    resetRedactionCursorIn(this.db, communityRef, remoteRoomId);
  }

  /** This owner's live mirror of a remote room, or `null`. */
  private applicableMirror(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string
  ) {
    const mirror = this.findRoom(communityRef, remoteRoomId);
    if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked')
      return null;
    return mirror;
  }

  /**
   * The local files of these changed entries that can only be matched to the Community's copy
   * by their bytes: delivered before the Community's id for them was recorded, on a message that
   * still has files there. The caller hashes them and hands the result to
   * {@link RemoteMirrorStore.plannedAttachmentDrops} and
   * {@link RemoteMirrorStore.applyRedactions}.
   */
  attachmentsNeedingChecksum(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    items: readonly NativeMirrorEntry[]
  ): Array<MirrorAttachmentFile & { mimeType: string }> {
    const mirror = this.applicableMirror(communityRef, remoteRoomId, ownerAuthorId);
    if (!mirror) return [];
    return attachmentsNeedingChecksumIn(
      this.db,
      mirror,
      communityRef,
      remoteRoomId,
      ownerAuthorId,
      items
    );
  }

  /**
   * The files {@link RemoteMirrorStore.applyRedactions} would drop for these items, read without
   * writing. The redaction sync deletes their bytes BEFORE it applies the page: if the process
   * stops in between, the page is not recorded as applied and the next sync applies it again, so
   * no file is ever left on disk with nothing pointing at it.
   *
   * @param checksums - As for {@link RemoteMirrorStore.applyRedactions}.
   * @returns An empty list when there is no mirror to update.
   */
  plannedAttachmentDrops(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    items: readonly NativeMirrorEntry[],
    checksums: ReadonlyMap<string, string> = new Map()
  ): MirrorAttachmentFile[] {
    const mirror = this.applicableMirror(communityRef, remoteRoomId, ownerAuthorId);
    if (!mirror) return [];
    return plannedAttachmentDropsIn(
      this.db,
      mirror,
      communityRef,
      remoteRoomId,
      ownerAuthorId,
      items,
      checksums
    );
  }

  /**
   * Delete attachment rows whose bytes are already gone: the redaction sync deleted them for a
   * page it then could not apply (the mirror was revoked or changed owner in between). A row
   * left behind would draw a file that can only answer 404.
   *
   * @param files - The files whose bytes were deleted.
   */
  forgetAttachmentRows(files: readonly MirrorAttachmentFile[]): void {
    for (const file of files) {
      this.db
        .delete(roomAttachments)
        .where(
          and(eq(roomAttachments.roomId, file.roomId), eq(roomAttachments.id, file.attachmentId))
        )
        .run();
    }
  }

  /**
   * Replace every local copy of remote entries that changed after they were posted, and store
   * the feed position, in one transaction.
   *
   * Each item is the entry as it stands now. A cached copy has its room-log text and mentions,
   * its retained adapter entry, and its author label rewritten; an entry's author label changes
   * only when its author was erased, so when it differs the external author's display name and
   * handle follow it. A local agent's own post that the outbox delivered as this entry is
   * rewritten too. An entry not cached yet is remembered, so a stream frame or history page read
   * before the change cannot import the older text later. Like an import, this never dispatches
   * a local agent, publishes, or indexes; the caller re-indexes the changed rows.
   *
   * A rewritten entry's files that the Community no longer carries on it lose their rows here
   * too, so the room stops offering them; their bytes are the caller's to delete. `checksums`
   * holds the SHA-256 of files delivered before their Community id was recorded (see
   * `attachmentsToDrop`); a file with neither is kept.
   *
   * @returns The local room, the rows that changed and the files dropped, or `null` when there
   *   is no mirror to update (none, another owner's, or revoked).
   */
  applyRedactions(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    items: readonly NativeMirrorEntry[],
    nextCursor: string,
    checksums: ReadonlyMap<string, string> = new Map()
  ): AppliedRedactions | null {
    const mirror = this.findRoom(communityRef, remoteRoomId);
    if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked')
      return null;
    return applyRedactionPage(
      this.db,
      this.authors,
      mirror,
      communityRef,
      remoteRoomId,
      ownerAuthorId,
      items,
      nextCursor,
      checksums
    );
  }

  /**
   * Every owner connection that still has mirrored content on this machine: a mirror not yet
   * revoked, or a revoked one whose local room was never purged. What the boot sweep checks
   * against the connection records (DOR-2334).
   */
  mirroredConnections(): { communityRef: CommunityRef; ownerAuthorId: string }[] {
    return mirroredConnectionsIn(this.db);
  }

  /** Mark a temporary outage: only the owner may read their last authorized rooms. */
  markStale(communityRef: CommunityRef, ownerAuthorId: string): void {
    markStaleIn(this.db, communityRef, ownerAuthorId);
  }

  /** Invalidate one owner's mirrors of a community after a remote `not-admitted` result. */
  revoke(communityRef: CommunityRef, ownerAuthorId: string): void {
    revokeOwnerMirrors(this.db, communityRef, ownerAuthorId);
  }

  /**
   * Revoke every persisted room absent from a complete enrolled-agent directory
   * read. Returning the local addresses lets the lifecycle stop held work
   * before a formerly joined agent can publish another remote reply.
   */
  revokeAbsentRooms(
    communityRef: CommunityRef,
    ownerAuthorId: string,
    allowedRemoteRoomIds: ReadonlySet<string>
  ): readonly RevokedRemoteMirrorRoom[] {
    return revokeAbsentMirrors(this.db, communityRef, ownerAuthorId, allowedRemoteRoomIds);
  }

  /**
   * Delete the content of every revoked mirror of one owner's connection. Called after the
   * turns those mirrors enabled have been halted, since a halt needs its room to exist.
   */
  purgeRevoked(communityRef: CommunityRef, ownerAuthorId: string): void {
    const purge = this.db.transaction((tx) =>
      purgeContent(
        tx,
        communityRef,
        tx
          .select({
            localRoomId: communityRoomMirrors.localRoomId,
            remoteRoomId: communityRoomMirrors.remoteRoomId,
          })
          .from(communityRoomMirrors)
          .where(
            and(
              eq(communityRoomMirrors.communityRef, communityRef),
              eq(communityRoomMirrors.ownerAuthorId, ownerAuthorId),
              eq(communityRoomMirrors.state, 'revoked')
            )
          )
          .all()
      )
    );
    if (purge.localRoomIds.length) this.purged?.(purge);
  }

  /** Return a mirror-local authorization answer before RoomVisibility checks owner power. */
  canRead(roomId: string, authorId: string): boolean | null {
    const mirror = this.db
      .select()
      .from(communityRoomMirrors)
      .where(eq(communityRoomMirrors.localRoomId, roomId))
      .get();
    if (!mirror) return null;
    if (mirror.state === 'revoked') return false;
    if (mirror.state === 'stale') return mirror.ownerAuthorId === authorId;
    const grant = this.db
      .select()
      .from(communityMirrorAccess)
      .where(
        and(
          eq(communityMirrorAccess.localRoomId, roomId),
          eq(communityMirrorAccess.authorId, authorId),
          eq(communityMirrorAccess.state, 'authorized')
        )
      )
      .get();
    return grant !== undefined;
  }

  /**
   * Whether a room is a mirror of this owner's connection that has been revoked.
   * `canRead` answers `false` for every caller once a mirror is revoked, so it
   * cannot tell the revocation's own cleanup apart from anybody else; this can.
   */
  isRevokedMirrorOf(roomId: string, ownerAuthorId: string): boolean {
    const mirror = this.db
      .select({
        state: communityRoomMirrors.state,
        ownerAuthorId: communityRoomMirrors.ownerAuthorId,
      })
      .from(communityRoomMirrors)
      .where(eq(communityRoomMirrors.localRoomId, roomId))
      .get();
    return mirror?.state === 'revoked' && mirror.ownerAuthorId === ownerAuthorId;
  }

  /**
   * The connection a local room mirrors, or `null` for a room that mirrors none: what a teammate
   * turn in it counts against (DOR-2956).
   */
  connectionOf(roomId: string): { communityRef: CommunityRef; ownerAuthorId: string } | null {
    const mirror = this.db
      .select({
        communityRef: communityRoomMirrors.communityRef,
        ownerAuthorId: communityRoomMirrors.ownerAuthorId,
      })
      .from(communityRoomMirrors)
      .where(eq(communityRoomMirrors.localRoomId, roomId))
      .get();
    return mirror
      ? { communityRef: mirror.communityRef as CommunityRef, ownerAuthorId: mirror.ownerAuthorId }
      : null;
  }

  /** Whether a mirror is actively authorized for fresh inbound work. */
  isActivelyAuthorized(roomId: string, ownerAuthorId: string): boolean {
    const mirror = this.db
      .select({
        state: communityRoomMirrors.state,
        ownerAuthorId: communityRoomMirrors.ownerAuthorId,
      })
      .from(communityRoomMirrors)
      .where(eq(communityRoomMirrors.localRoomId, roomId))
      .get();
    return mirror?.state === 'authorized' && mirror.ownerAuthorId === ownerAuthorId;
  }

  /**
   * Fresh inbound work must not revive a stale or revoked cached grant.
   *
   * An absent row is the first authorized lifecycle snapshot for a newly
   * discovered room, so it may proceed to `ensureRoom`; only a persisted
   * non-current row is a fail-closed answer before that method can refresh it.
   */
  isAddressActivelyAuthorized(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string
  ): boolean {
    const row = this.findRoom(communityRef, remoteRoomId);
    return row === undefined || (row.state === 'authorized' && row.ownerAuthorId === ownerAuthorId);
  }

  /**
   * Resolve an existing cache target without changing its persisted authority.
   *
   * `undefined` means a newly authorized lifecycle directory may create this
   * mirror. `null` means a revoked mapping, which old snapshot/history frames
   * must leave alone. A stale owner cache remains readable, so it returns its
   * room without ever promoting it back to authorized.
   */
  cachedRoomForImport(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string
  ): Room | null | undefined {
    const row = this.findRoom(communityRef, remoteRoomId);
    if (!row) return undefined;
    if (row.ownerAuthorId !== ownerAuthorId || row.state === 'revoked') return null;
    return this.roomsStore.getRoom(row.localRoomId);
  }

  /** Persisted local room ids for one owner's connected community. */
  roomIdsForOwner(communityRef: CommunityRef, ownerAuthorId: string): readonly string[] {
    // Inner join: a revoked mirror whose room was purged has no local room left to act on.
    return this.db
      .select({ localRoomId: communityRoomMirrors.localRoomId })
      .from(communityRoomMirrors)
      .innerJoin(rooms, eq(rooms.id, communityRoomMirrors.localRoomId))
      .where(
        and(
          eq(communityRoomMirrors.communityRef, communityRef),
          eq(communityRoomMirrors.ownerAuthorId, ownerAuthorId)
        )
      )
      .all()
      .map((row) => row.localRoomId);
  }

  /** Revoke one local agent's access without changing other enrolled agents' grants. */
  revokeAgentAccess(communityRef: CommunityRef, ownerAuthorId: string, authorId: string): void {
    revokeAgentAccessIn(this.db, communityRef, ownerAuthorId, authorId);
  }

  /** Revoke one agent's access to one qualified mirror without touching other grants. */
  revokeRoomAgentAccess(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    authorId: string
  ): void {
    const localRoomId = this.localRoomIdForOwner(communityRef, remoteRoomId, ownerAuthorId);
    if (!localRoomId) return;
    this.db
      .update(communityMirrorAccess)
      .set({ state: 'revoked' })
      .where(
        and(
          eq(communityMirrorAccess.localRoomId, localRoomId),
          eq(communityMirrorAccess.authorId, authorId)
        )
      )
      .run();
  }

  /** Remove one agent's local room membership after the matching halt completes. */
  removeRoomAgentMembership(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    authorId: string
  ): void {
    const localRoomId = this.localRoomIdForOwner(communityRef, remoteRoomId, ownerAuthorId);
    if (!localRoomId) return;
    this.db
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, localRoomId), eq(roomMembers.authorId, authorId)))
      .run();
  }

  /**
   * Remove an ejected agent from the mirrored local room after its running
   * turn has been halted. The access row is revoked first so this cleanup
   * cannot reopen a live-dispatch window while the halt awaits.
   */
  removeAgentMembership(communityRef: CommunityRef, ownerAuthorId: string, authorId: string): void {
    removeAgentMembershipIn(this.db, communityRef, ownerAuthorId, authorId);
  }

  /** Resolve a qualified remote room to its opaque local mirror id for local-only Stop. */
  localRoomIdForOwner(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string
  ): string | null {
    const row = this.findRoom(communityRef, remoteRoomId);
    if (row?.ownerAuthorId !== ownerAuthorId) return null;
    // A purged mirror's local room is gone; there is nothing local to stop or read.
    return this.roomsStore.getRoom(row.localRoomId) ? row.localRoomId : null;
  }

  /** Trusted outbound address for a local mirror row, or null for ordinary rooms. */
  outboundAddress(
    roomId: string
  ): { communityRef: CommunityRef; remoteRoomId: string; ownerAuthorId: string } | null {
    const row = this.db
      .select()
      .from(communityRoomMirrors)
      .where(eq(communityRoomMirrors.localRoomId, roomId))
      .get();
    return row
      ? {
          communityRef: row.communityRef as CommunityRef,
          remoteRoomId: row.remoteRoomId,
          ownerAuthorId: row.ownerAuthorId,
        }
      : null;
  }

  /** Resolve an imported local entry back to its remote parent identity for an outbound reply. */
  remoteEntryIdForLocal(roomId: string, localEntryId: string): string | null {
    return (
      this.db
        .select({ remoteEntryId: communityMirrorEntries.remoteEntryId })
        .from(communityMirrorEntries)
        .where(
          and(
            eq(communityMirrorEntries.localRoomId, roomId),
            eq(communityMirrorEntries.localEntryId, localEntryId)
          )
        )
        .get()?.remoteEntryId ?? null
    );
  }

  /** Whether this installation has any mirrors that make owner-wide access unsafe. */
  hasMirrors(): boolean {
    return (
      this.db
        .select({ localRoomId: communityRoomMirrors.localRoomId })
        .from(communityRoomMirrors)
        .get() !== undefined
    );
  }

  private findRoom(communityRef: CommunityRef, remoteRoomId: string) {
    return findMirror(this.db, communityRef, remoteRoomId);
  }
}
