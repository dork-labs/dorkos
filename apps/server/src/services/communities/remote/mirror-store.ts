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
  roomEntries,
  roomMembers,
  rooms,
  sql,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
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
  author: { memberId: string; displayName: string };
}

/** One local mirror lookup, used by RoomVisibility before owner-wide access. */
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
  constructor(
    private readonly db: Db,
    private readonly roomsStore: RoomStore,
    private readonly authors: AuthorRegistry
  ) {}

  /** Create or refresh one authorized mirror and its local read grants. */
  ensureRoom(input: MirrorRoomInput): Room {
    const existing = this.findRoom(input.communityRef, input.remoteRoomId);
    if (existing) {
      this.refreshAccess(existing.localRoomId, input);
      const room = this.roomsStore.getRoom(existing.localRoomId);
      if (!room) throw new Error('A community mirror mapping points to a missing local room');
      return room;
    }

    const accessors = dedupeAccessors(input.ownerAuthorId, input.accessors);
    const createdAt = input.authorizedAt;
    const localRoomId = ulid();
    try {
      return this.roomsStore.createRoom(
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
    } catch (error) {
      // `createRoom`'s callback is transactional. A competing cache import
      // therefore leaves no stray local room; adopt the mapping that won.
      const raced = this.findRoom(input.communityRef, input.remoteRoomId);
      if (!raced) throw error;
      this.refreshAccess(raced.localRoomId, input);
      const room = this.roomsStore.getRoom(raced.localRoomId);
      if (!room) throw error;
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

  /** Invalidate all content after a remote `not-admitted` result. */
  revoke(communityRef: CommunityRef): void {
    this.db.transaction((tx) => {
      const mirrored = tx
        .select({ localRoomId: communityRoomMirrors.localRoomId })
        .from(communityRoomMirrors)
        .where(eq(communityRoomMirrors.communityRef, communityRef))
        .all();
      tx.update(communityRoomMirrors)
        .set({ state: 'revoked' })
        .where(eq(communityRoomMirrors.communityRef, communityRef))
        .run();
      for (const row of mirrored) {
        tx.update(communityMirrorAccess)
          .set({ state: 'revoked' })
          .where(eq(communityMirrorAccess.localRoomId, row.localRoomId))
          .run();
      }
    });
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
    item: NativeMirrorEntry
  ): RoomEntry | null {
    const external = this.authors.resolveExternal({
      platformType: 'community',
      instanceId: communityRef,
      platformUserId: item.author.memberId,
      displayName: item.author.displayName,
    });
    return this.db.transaction((tx) => {
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
      tx.insert(roomEntries)
        .values({
          roomId: localRoomId,
          seq: item.remoteSeq,
          id: localEntryId,
          authorId: external.id,
          kind: 'post',
          body: JSON.stringify({ text: item.entry.text }),
          mentions: '[]',
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
      tx.insert(communityMirrorEntries)
        .values({
          communityRef,
          remoteRoomId,
          remoteEntryId: item.entry.id,
          localRoomId,
          localEntryId,
          remoteSeq: item.remoteSeq,
        })
        .run();
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
    });
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
