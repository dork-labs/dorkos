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
  communityMirrorRedactions,
  communityOutbox,
  communityRoomMirrors,
  eq,
  gt,
  inArray,
  isNull,
  readCursors,
  roomAttachments,
  roomEntries,
  roomMembers,
  roomSessions,
  rooms,
  sql,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  CommunityEntrySchema,
  type CommunityEntry,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import {
  deleteRoomNotifications,
  rewriteRoomEntryNotifications,
} from '../../notifications/room-entry-notifications.js';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import type { RoomStore } from '../../rooms/room-store.js';
import { toEntry } from '../../rooms/room-rows.js';

/** The current remote authorization state represented by a local cache row. */
export type MirrorState = 'authorized' | 'stale' | 'revoked';

/** A local principal allowed to read an imported room. */
export interface MirrorAccessor {
  authorId: string;
  responseMode?: ResponseMode;
}

/** Remote room data that is safe to project into the local cache. */
export interface MirrorRoomInput {
  communityRef: CommunityRef;
  remoteRoomId: string;
  title: string;
  topic: string | null;
  ownerAuthorId: string;
  accessors: readonly MirrorAccessor[];
  authorizedAt: string;
}

/** The native-only sequence retained beside an opaque generic community entry. */
export interface NativeMirrorEntry {
  entry: CommunityEntry;
  /** The authoritative sequence emitted by the native community wire. */
  remoteSeq: number;
  /** The raw remote author id and display label; it is always external locally. */
  author: { memberId: string; displayName: string; kind: 'human' | 'agent' | 'system' };
}

/** One owner-authorized cached entry with its native provenance metadata. */
export interface CachedRemoteEntry {
  entry: CommunityEntry;
  remoteSeq: number;
  /** Null only for rows cached before native author metadata was retained. */
  author: { memberId: string; displayName: string; kind: 'human' | 'agent' | 'system' } | null;
}

/** What a revocation removed from this machine, for the stores beside the room log. */
export interface MirrorPurge {
  /** Local rooms whose entries were deleted. */
  localRoomIds: readonly string[];
  /** Files that belonged to those entries; their bytes are the caller's to delete. */
  attachments: readonly { roomId: string; attachmentId: string; extension: string }[];
}

/** What one page of the redaction feed changed in a mirror. */
export interface AppliedRedactions {
  localRoomId: string;
  /** Local `seq` of every room entry rewritten, for re-indexing. */
  changedSeqs: readonly number[];
}

/** One persisted mirror invalidated because no active enrolled agent still sees it. */
export interface RevokedRemoteMirrorRoom {
  localRoomId: string;
  remoteRoomId: string;
}

export interface MirrorRoomAccess {
  /** `null` means the local room is not a remote mirror. */
  canRead(roomId: string, authorId: string): boolean | null;
  /** Whether owner-wide search/listing needs the mirror-aware path. */
  hasMirrors(): boolean;
}

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
        ? this.forgetMapping(found.localRoomId)
        : found;
    if (existing) {
      this.refreshAccess(existing.localRoomId, input);
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
      this.refreshAccess(raced.localRoomId, input);
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
    const ordered = [...entries].sort((a, b) => a.remoteSeq - b.remoteSeq);
    const imported: RoomEntry[] = [];
    for (const item of ordered) {
      if (!Number.isSafeInteger(item.remoteSeq) || item.remoteSeq <= 0) {
        throw new Error('A native community entry needs a positive integer sequence');
      }
      if (item.entry.community !== communityRef || item.entry.roomId !== remoteRoomId) {
        throw new Error('A native community entry does not belong to this mirror');
      }
      const saved = this.importEntry(mirror.localRoomId, communityRef, remoteRoomId, item);
      if (saved) imported.push(saved);
    }
    return imported;
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
    const result = this.db
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
    const mirror = this.findRoom(communityRef, remoteRoomId);
    if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked')
      return null;
    const row = this.db
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
    const mirror = this.findRoom(communityRef, remoteRoomId);
    if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked')
      return null;
    const row = this.db
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
    const mirror = this.findRoom(communityRef, remoteRoomId);
    if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked') return [];
    const limit = Math.min(Math.max(0, opts.limit), 200);
    if (limit === 0) return [];
    return (
      this.db
        .select({ entryJson: communityMirrorEntries.entryJson })
        .from(communityMirrorEntries)
        .where(
          and(
            eq(communityMirrorEntries.communityRef, communityRef),
            eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
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
    this.db
      .update(communityRoomMirrors)
      .set({ redactionCursor: null })
      .where(
        and(
          eq(communityRoomMirrors.communityRef, communityRef),
          eq(communityRoomMirrors.remoteRoomId, remoteRoomId)
        )
      )
      .run();
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
   * @returns The local room and the rows that changed, or `null` when there is no mirror to
   *   update (none, another owner's, or revoked).
   */
  applyRedactions(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    items: readonly NativeMirrorEntry[],
    nextCursor: string
  ): AppliedRedactions | null {
    const mirror = this.findRoom(communityRef, remoteRoomId);
    if (!mirror || mirror.ownerAuthorId !== ownerAuthorId || mirror.state === 'revoked')
      return null;
    for (const item of items) {
      if (item.entry.community !== communityRef || item.entry.roomId !== remoteRoomId) {
        throw new Error('A changed community entry does not belong to this mirror');
      }
    }
    const localRoomId = mirror.localRoomId;
    return this.db.transaction(
      (tx) => {
        const changedSeqs: number[] = [];
        const rewrite = (
          localEntryId: string,
          item: NativeMirrorEntry,
          keepMentions: boolean,
          renamedTo?: string
        ) => {
          const row = tx
            .update(roomEntries)
            .set({
              body: JSON.stringify({ text: item.entry.text }),
              // A local post's mentions are local author ids; a change only ever removes them.
              ...(keepMentions && item.entry.mentions.length
                ? {}
                : { mentions: JSON.stringify(item.entry.mentions), mentionSpans: '[]' }),
            })
            .where(and(eq(roomEntries.roomId, localRoomId), eq(roomEntries.id, localEntryId)))
            .returning({ seq: roomEntries.seq })
            .get();
          if (!row) return;
          changedSeqs.push(row.seq);
          // An inbox notification that quoted the entry is a copy too.
          rewriteRoomEntryNotifications(tx, localRoomId, localEntryId, {
            text: item.entry.text,
            ...(renamedTo ? { fromName: renamedTo } : {}),
          });
        };
        for (const item of items) {
          const entryJson = JSON.stringify(CommunityEntrySchema.parse(item.entry));
          const delivered = tx
            .select({ localEntryId: communityOutbox.localEntryId })
            .from(communityOutbox)
            .where(
              and(
                eq(communityOutbox.communityRef, communityRef),
                eq(communityOutbox.remoteRoomId, remoteRoomId),
                eq(communityOutbox.ownerAuthorId, ownerAuthorId),
                eq(communityOutbox.remoteEntryId, item.entry.id)
              )
            )
            .all();
          for (const post of delivered) rewrite(post.localEntryId, item, true);
          const cached = tx
            .select({
              localEntryId: communityMirrorEntries.localEntryId,
              entryJson: communityMirrorEntries.entryJson,
              authorDisplayName: communityMirrorEntries.authorDisplayName,
              authorKind: communityMirrorEntries.authorKind,
            })
            .from(communityMirrorEntries)
            .where(
              and(
                eq(communityMirrorEntries.communityRef, communityRef),
                eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
                eq(communityMirrorEntries.remoteEntryId, item.entry.id)
              )
            )
            .get();
          if (!cached) {
            // Remembered even when a local post was rewritten above: the post's own echo may
            // still arrive from the stream, and must be stored as it is now.
            tx.insert(communityMirrorRedactions)
              .values({
                communityRef,
                remoteRoomId,
                remoteEntryId: item.entry.id,
                entryJson,
                authorDisplayName: item.author.displayName,
                authorKind: item.author.kind,
              })
              .onConflictDoUpdate({
                target: [
                  communityMirrorRedactions.communityRef,
                  communityMirrorRedactions.remoteRoomId,
                  communityMirrorRedactions.remoteEntryId,
                ],
                set: {
                  entryJson,
                  authorDisplayName: item.author.displayName,
                  authorKind: item.author.kind,
                },
              })
              .run();
            continue;
          }
          if (
            cached.entryJson === entryJson &&
            cached.authorDisplayName === item.author.displayName &&
            cached.authorKind === item.author.kind
          ) {
            continue;
          }
          if (cached.authorDisplayName !== item.author.displayName) {
            // Only erasure changes the name a message shows. Its handle was derived from the
            // erased name, so it is re-derived too.
            this.authors.renameErasedExternal({
              platformType: 'community',
              instanceId: communityRef,
              platformUserId: item.author.memberId,
              displayName: item.author.displayName,
            });
          }
          rewrite(
            cached.localEntryId,
            item,
            false,
            cached.authorDisplayName !== item.author.displayName
              ? item.author.displayName
              : undefined
          );
          tx.update(communityMirrorEntries)
            .set({
              entryJson,
              authorDisplayName: item.author.displayName,
              authorKind: item.author.kind,
            })
            .where(
              and(
                eq(communityMirrorEntries.communityRef, communityRef),
                eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
                eq(communityMirrorEntries.remoteEntryId, item.entry.id)
              )
            )
            .run();
        }
        tx.update(communityRoomMirrors)
          .set({ redactionCursor: nextCursor })
          .where(eq(communityRoomMirrors.localRoomId, localRoomId))
          .run();
        return { localRoomId, changedSeqs };
      },
      { behavior: 'immediate' }
    );
  }

  /** Mark a temporary outage: only the owner may read their last authorized rooms. */
  markStale(communityRef: CommunityRef, ownerAuthorId: string): void {
    this.db
      .update(communityRoomMirrors)
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

  /** Invalidate one owner's mirrors of a community after a remote `not-admitted` result. */
  revoke(communityRef: CommunityRef, ownerAuthorId: string): void {
    this.db.transaction((tx) => {
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
   * Revoke every persisted room absent from a complete enrolled-agent directory
   * read. Returning the local addresses lets the lifecycle stop held work
   * before a formerly joined agent can publish another remote reply.
   */
  revokeAbsentRooms(
    communityRef: CommunityRef,
    ownerAuthorId: string,
    allowedRemoteRoomIds: ReadonlySet<string>
  ): readonly RevokedRemoteMirrorRoom[] {
    return this.db.transaction((tx) => {
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
   * Delete the content of every revoked mirror of one owner's connection. Called after the
   * turns those mirrors enabled have been halted, since a halt needs its room to exist.
   */
  purgeRevoked(communityRef: CommunityRef, ownerAuthorId: string): void {
    const purge = this.db.transaction((tx) =>
      this.purgeContent(
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

  /**
   * Delete what a revoked mirror held, down to its local room: entries (their reactions cascade),
   * files, members, agent sessions, read positions, inbox notifications about it, cached remote
   * entries, and remembered changes. A revoked mirror is unreadable here and no longer reads the redaction feed, so a
   * later deletion, removal, or erasure on the server could never reach its copy; keeping none
   * is the only way that copy cannot outlive one. The mapping row stays, revoked, so a late
   * stream frame cannot recreate the room; readmission gives it a fresh local room
   * ({@link RemoteMirrorStore.ensureRoom}). A room already deleted is skipped.
   */
  private purgeContent(
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

  /** Drop a mapping whose local room was purged, so readmission can create a fresh one. */
  private forgetMapping(localRoomId: string): undefined {
    this.db.transaction((tx) => {
      tx.delete(communityMirrorAccess)
        .where(eq(communityMirrorAccess.localRoomId, localRoomId))
        .run();
      tx.delete(communityRoomMirrors)
        .where(eq(communityRoomMirrors.localRoomId, localRoomId))
        .run();
    });
    return undefined;
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
    const rooms = this.db
      .select({ localRoomId: communityRoomMirrors.localRoomId })
      .from(communityRoomMirrors)
      .where(
        and(
          eq(communityRoomMirrors.communityRef, communityRef),
          eq(communityRoomMirrors.ownerAuthorId, ownerAuthorId)
        )
      )
      .all();
    this.db.transaction((tx) => {
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
    const rooms = this.db
      .select({ localRoomId: communityRoomMirrors.localRoomId })
      .from(communityRoomMirrors)
      .where(
        and(
          eq(communityRoomMirrors.communityRef, communityRef),
          eq(communityRoomMirrors.ownerAuthorId, ownerAuthorId)
        )
      )
      .all();
    this.db.transaction((tx) => {
      for (const room of rooms) {
        tx.delete(roomMembers)
          .where(and(eq(roomMembers.roomId, room.localRoomId), eq(roomMembers.authorId, authorId)))
          .run();
      }
    });
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
    return this.db
      .select()
      .from(communityRoomMirrors)
      .where(
        and(
          eq(communityRoomMirrors.communityRef, communityRef),
          eq(communityRoomMirrors.remoteRoomId, remoteRoomId)
        )
      )
      .get();
  }

  private refreshAccess(localRoomId: string, input: MirrorRoomInput): void {
    const accessors = dedupeAccessors(input.ownerAuthorId, input.accessors);
    this.db.transaction((tx) => {
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

  private importEntry(
    localRoomId: string,
    communityRef: CommunityRef,
    remoteRoomId: string,
    frame: NativeMirrorEntry
  ): RoomEntry | null {
    // A change the redaction feed reported before this entry was cached wins over the frame,
    // which may have been read before the change.
    const item = this.withKnownRedaction(communityRef, remoteRoomId, frame);
    const external = this.authors.resolveExternal({
      platformType: 'community',
      instanceId: communityRef,
      platformUserId: item.author.memberId,
      displayName: item.author.displayName,
    });
    return this.db.transaction(
      (tx) => {
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
          const row = tx
            .select()
            .from(roomEntries)
            .where(
              and(eq(roomEntries.roomId, localRoomId), eq(roomEntries.id, existing.localEntryId))
            )
            .get();
          return row ? toEntry(row) : null;
        }

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

        const parentEntryId = this.localEntryId(
          tx,
          communityRef,
          remoteRoomId,
          item.entry.parentEntryId
        );
        const threadRootEntryId = this.localEntryId(
          tx,
          communityRef,
          remoteRoomId,
          item.entry.threadRootEntryId
        );
        const localEntryId = ulid();
        tx.insert(roomMembers)
          .values({
            roomId: localRoomId,
            authorId: external.id,
            responseMode: 'silent',
            joinedAt: item.entry.createdAt,
            joinedSeq: 0,
            lastReadSeq: 0,
          })
          .onConflictDoNothing()
          .run();
        const allocated = tx
          .select({ next: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0) + 1` })
          .from(roomEntries)
          .where(eq(roomEntries.roomId, localRoomId))
          .get();
        const localSeq = allocated?.next ?? 1;
        tx.insert(roomEntries)
          .values({
            roomId: localRoomId,
            seq: localSeq,
            id: localEntryId,
            authorId: external.id,
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
          })
          .run();
        this.repairRelations(tx, communityRef, remoteRoomId, localRoomId);
        tx.update(rooms)
          // A late history page may be older than the snapshot already cached.
          // Keep the newest server timestamp only for sidebar activity; remote
          // sequence remains the authoritative order everywhere else.
          .set({
            lastActivityAt: sql`CASE WHEN ${rooms.lastActivityAt} > ${item.entry.createdAt} THEN ${rooms.lastActivityAt} ELSE ${item.entry.createdAt} END`,
          })
          .where(eq(rooms.id, localRoomId))
          .run();
        const row = tx
          .select()
          .from(roomEntries)
          .where(and(eq(roomEntries.roomId, localRoomId), eq(roomEntries.id, localEntryId)))
          .get();
        return row ? toEntry(row) : null;
      },
      { behavior: 'immediate' }
    );
  }

  /** The entry as the redaction feed last reported it, when it changed before it was cached. */
  private withKnownRedaction(
    communityRef: CommunityRef,
    remoteRoomId: string,
    item: NativeMirrorEntry
  ): NativeMirrorEntry {
    const known = this.db
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

  private localEntryId(
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

  /** Repair children imported before their parent or thread root arrived. */
  private repairRelations(
    tx: Db | DbTransaction,
    communityRef: CommunityRef,
    remoteRoomId: string,
    localRoomId: string
  ): void {
    const cached = tx
      .select({
        localEntryId: communityMirrorEntries.localEntryId,
        entryJson: communityMirrorEntries.entryJson,
      })
      .from(communityMirrorEntries)
      .where(
        and(
          eq(communityMirrorEntries.communityRef, communityRef),
          eq(communityMirrorEntries.remoteRoomId, remoteRoomId)
        )
      )
      .all();
    for (const row of cached) {
      // Rows imported before the opaque cache field existed are intentionally
      // unreadable through this projection; a fresh remote page replaces them.
      if (!row.entryJson) continue;
      const entry = CommunityEntrySchema.parse(JSON.parse(row.entryJson));
      const parentEntryId = this.localEntryId(tx, communityRef, remoteRoomId, entry.parentEntryId);
      const threadRootEntryId = this.localEntryId(
        tx,
        communityRef,
        remoteRoomId,
        entry.threadRootEntryId
      );
      tx.update(roomEntries)
        .set({ parentEntryId, threadRootEntryId })
        .where(and(eq(roomEntries.roomId, localRoomId), eq(roomEntries.id, row.localEntryId)))
        .run();
    }
  }
}

/** Keep the owner and every explicitly enrolled agent exactly once. */
function dedupeAccessors(
  ownerAuthorId: string,
  accessors: readonly MirrorAccessor[]
): MirrorAccessor[] {
  const values = new Map<string, MirrorAccessor>();
  values.set(ownerAuthorId, { authorId: ownerAuthorId, responseMode: 'silent' });
  for (const accessor of accessors) values.set(accessor.authorId, accessor);
  return [...values.values()];
}

/** Rehydrate optional native provenance without inferring anything from a label. */
function toCachedEntry(row: {
  entryJson: string | null;
  remoteSeq: number;
  authorDisplayName: string | null;
  authorKind: string | null;
}): CachedRemoteEntry | null {
  if (!row.entryJson) return null;
  const entry = CommunityEntrySchema.parse(JSON.parse(row.entryJson));
  const author = isNativeAuthorKind(row.authorKind)
    ? {
        memberId: entry.authorId,
        displayName: row.authorDisplayName ?? entry.authorId,
        kind: row.authorKind,
      }
    : null;
  return { entry, remoteSeq: row.remoteSeq, author };
}

/** The three native member kinds the remote server vouches for on its wire. */
function isNativeAuthorKind(value: string | null): value is 'human' | 'agent' | 'system' {
  return value === 'human' || value === 'agent' || value === 'system';
}
