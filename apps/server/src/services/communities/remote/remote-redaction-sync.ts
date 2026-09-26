/**
 * Replaces this installation's cached copies of Community messages that were deleted, removed,
 * or erased on the server, by reading each mirrored channel's redaction feed.
 *
 * @module services/communities/remote/remote-redaction-sync
 */
import { sql, type Db } from '@dorkos/db';
import {
  CommunityRoomNotFoundError,
  StaleCommunityCursorError,
  type CommunityReadContext,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import { logger } from '../../../lib/logger.js';
import type { RoomAttachmentStore } from '../../rooms/attachments/room-attachment-store.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { dropRoomFromIndex, optimizeSearchIndex, reindexRoomEntries } from '../../search/index.js';
import type { MirrorPurge, NativeMirrorEntry, RemoteMirrorStore } from './mirror-store.js';
import {
  RemoteRedactionFeedUnsupportedError,
  type RemoteCommunityAdapter,
} from './remote-community-adapter.js';

/** How often a subscribed room reads its redaction feed between reconnects: 15 minutes. */
export const REDACTION_SYNC_INTERVAL_MS = 15 * 60_000;

/**
 * How long a connection whose server answered without the feed goes unasked by the interval: an
 * hour. A reconnect's replay always asks again, so an upgraded server is found at once.
 */
export const UNSUPPORTED_RECHECK_MS = 60 * 60_000;

/** The most pages one sync reads, so a very long backlog yields between syncs. */
const MAX_PAGES_PER_SYNC = 50;

/** The one adapter method the sync needs. */
export type RedactionFeedReader = Pick<RemoteCommunityAdapter, 'readRedactions'>;

/** One mirrored remote room, owner-qualified. */
export interface RedactionSyncRoom {
  communityRef: CommunityRef;
  remoteRoomId: string;
  ownerAuthorId: string;
}

/** Dependencies the server bootstrap already owns. */
export interface RemoteRedactionSyncDeps {
  /** The database holding the mirror, the room log, and the search index. */
  db: Db;
  mirrors: RemoteMirrorStore;
  readers: (communityRef: CommunityRef, ownerAuthorId: string) => RedactionFeedReader | null;
  /** Where the files of a purged mirror's entries live. */
  attachmentBytes?: Pick<RoomAttachmentStore, 'delete'>;
  now?: () => number;
}

/**
 * Pulls redaction feeds into the local mirror, and cleans up after a mirror is purged.
 *
 * For each page, every local copy of a changed entry (the cached remote entry, and a local
 * agent's own delivered post) is rewritten, those rows are re-indexed for search, and the page's
 * cursor is stored, in one SQLite transaction. Once per sync that changed anything, an FTS5
 * `optimize` and a WAL checkpoint follow; with the database's `secure_delete`, the replaced text
 * then leaves the database file, the search index's storage, and the write-ahead log, not only
 * the rows a query can see. It never dispatches a local agent: a change to an old message is not
 * new work.
 *
 * What it cannot reach, by design: anything a local agent already saved (session transcripts,
 * memory) belongs to that agent's owner and is not touched. A mirror whose access is revoked
 * cannot read the feed any more, so the mirror store deletes its content instead
 * ({@link RemoteRedactionSync.afterPurge} finishes that here).
 */
export class RemoteRedactionSync {
  private readonly inFlight = new Map<string, Promise<void>>();
  /** When a connection's server last answered without the feed. */
  private readonly unsupportedAt = new Map<string, number>();
  private scrubbing: Promise<void> | undefined;

  constructor(private readonly deps: RemoteRedactionSyncDeps) {}

  /**
   * Bring one mirrored room up to date with its redaction feed. Concurrent calls for the same
   * room (one subscription per enrolled agent) share one read. Never throws: a failure is logged
   * and the next sync starts from the stored cursor.
   *
   * @param room - The owner-qualified mirror.
   * @param context - Who reads the feed; the subscription's enrolled agent.
   * @param options - `recheck` asks even a server that answered without the feed within the
   *   last hour; a reconnect's replay passes it.
   */
  sync(
    room: RedactionSyncRoom,
    context: CommunityReadContext,
    options: { recheck?: boolean } = {}
  ): Promise<void> {
    const key = `${room.communityRef}\0${room.ownerAuthorId}\0${room.remoteRoomId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const started = this.run(room, context, options.recheck === true)
      .catch((error: unknown) => {
        logger.warn('[communities] reading changed messages failed; the next sync retries', {
          communityRef: room.communityRef,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  /**
   * Finish a purge the mirror store made when it revoked mirrors: drop the deleted rooms from
   * search, delete their files, tell open windows the rooms changed, and scrub the index and the
   * log. A search drop that fails is logged; the next search sweep prunes rooms that no longer
   * exist, so it is retried there rather than lost.
   *
   * @param purge - What the revocation deleted.
   */
  afterPurge(purge: MirrorPurge): void {
    for (const roomId of purge.localRoomIds) {
      try {
        dropRoomFromIndex(this.deps.db, roomId);
      } catch (error) {
        logger.warn(
          '[communities] could not drop a closed mirror from search yet; the next sweep will',
          {
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
      // The room list re-reads on this, so an open window drops the room.
      eventFanOut.broadcast('room_updated', { roomId });
    }
    for (const file of purge.attachments) {
      void this.deps.attachmentBytes
        ?.delete(file.roomId, file.attachmentId, file.extension)
        .catch(() => undefined);
    }
    void this.scrub();
  }

  /** Resolves once any scheduled index optimize and log checkpoint have run. */
  whenScrubbed(): Promise<void> {
    return this.scrubbing ?? Promise.resolve();
  }

  private async run(
    room: RedactionSyncRoom,
    context: CommunityReadContext,
    recheck: boolean
  ): Promise<void> {
    const connection = `${room.communityRef}\0${room.ownerAuthorId}`;
    const now = this.deps.now ?? (() => Date.now());
    const markedAt = this.unsupportedAt.get(connection);
    if (markedAt !== undefined && !recheck && now() - markedAt < UNSUPPORTED_RECHECK_MS) return;
    const reader = this.deps.readers(room.communityRef, room.ownerAuthorId);
    if (!reader) return;
    let restarted = false;
    let changed = false;
    try {
      for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_SYNC; pageNumber++) {
        const state = this.deps.mirrors.redactionCursor(
          room.communityRef,
          room.remoteRoomId,
          room.ownerAuthorId
        );
        if (!state) return;
        let page;
        try {
          page = await reader.readRedactions(room.remoteRoomId, {
            cursor: state.cursor ?? undefined,
            actingMemberId: context.actingMemberId,
          });
        } catch (error) {
          if (error instanceof RemoteRedactionFeedUnsupportedError) {
            if (markedAt === undefined) {
              logger.info(
                '[communities] this Community server does not publish changed messages; cached copies stay as they are until it is updated',
                { communityRef: room.communityRef }
              );
            }
            this.unsupportedAt.set(connection, now());
            return;
          }
          // The server replaced its redaction history (a backup restore): read it all again.
          if (error instanceof StaleCommunityCursorError && !restarted) {
            restarted = true;
            this.deps.mirrors.resetRedactionCursor(room.communityRef, room.remoteRoomId);
            continue;
          }
          // The channel is no longer readable; the directory reconcile revokes the mirror.
          if (error instanceof CommunityRoomNotFoundError) return;
          throw error;
        }
        this.unsupportedAt.delete(connection);
        if (this.apply(room, page.items, page.nextCursor)) changed = true;
        if (!page.hasMore) return;
      }
    } finally {
      if (changed) await this.scrub();
    }
  }

  /**
   * Rewrite one page into the mirror and re-index the rows it changed, in one transaction, so
   * search never answers with text the room log no longer has.
   *
   * @returns Whether any local row changed.
   */
  private apply(room: RedactionSyncRoom, items: NativeMirrorEntry[], nextCursor: string): boolean {
    const { db } = this.deps;
    return db.transaction(
      () => {
        const applied = this.deps.mirrors.applyRedactions(
          room.communityRef,
          room.remoteRoomId,
          room.ownerAuthorId,
          items,
          nextCursor
        );
        if (!applied?.changedSeqs.length) return false;
        reindexRoomEntries(db, applied.localRoomId, applied.changedSeqs);
        return true;
      },
      { behavior: 'immediate' }
    );
  }

  /**
   * Merge the search index's segments and restart the write-ahead log, once for every sync and
   * purge that lands in the same turn of the event loop. Both rewrite in proportion to the
   * database, so they run once per batch of changes, never once per page.
   *
   * The database runs with `PRAGMA secure_delete` on (`createDb`), so the pages the merge frees
   * are zeroed. The rewritten pages went through the WAL, whose older frames still hold the old
   * text until a checkpoint copies the new pages home and the log restarts. A reader holding an
   * old snapshot can stop it from finishing; the next scrub or SQLite's own checkpoint completes
   * it, so a busy result is not an error.
   */
  private scrub(): Promise<void> {
    this.scrubbing ??= new Promise<void>((resolve) => {
      setImmediate(() => {
        this.scrubbing = undefined;
        try {
          optimizeSearchIndex(this.deps.db);
          this.deps.db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
        } catch (error) {
          logger.warn('[communities] could not compact search after replacing messages', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        resolve();
      });
    });
    return this.scrubbing;
  }
}
