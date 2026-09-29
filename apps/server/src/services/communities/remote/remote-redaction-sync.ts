/**
 * Replaces this installation's cached copies of Community messages that were deleted, removed,
 * or erased on the server, by reading each mirrored channel's redaction feed.
 *
 * @module services/communities/remote/remote-redaction-sync
 */
import { createHash } from 'node:crypto';
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
import type {
  AppliedRedactions,
  MirrorAttachmentFile,
  MirrorPurge,
  NativeMirrorEntry,
  RemoteMirrorStore,
} from './mirror-store.js';
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
  /** Where the files of mirrored rooms live: a purged mirror's, and a redacted entry's. */
  attachmentBytes?: Pick<RoomAttachmentStore, 'delete' | 'get'>;
  /**
   * Tell the mirrored room's open readers which of its entries were rewritten, once the rewrite
   * has committed. `RoomService.publishEntryRevisions` in production: it reads the rows back from
   * the log, so the frames carry the tombstone and never the text it replaced.
   */
  publishRevisions?: (localRoomId: string, seqs: readonly number[]) => void;
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
 * the rows a query can see. Once a page commits, any open window of the room replaces the changed
 * messages in place (DOR-2336). It never dispatches a local agent: a change to an old message is not
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
    // Rooms whose lists and Threads should re-read, once per sync however many pages changed.
    const touched = new Set<string>();
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
        // Files first (DOR-2549): the bytes of every file this page will drop are deleted
        // BEFORE the page is applied. Should the process stop in between, the page and its
        // cursor were never recorded, so the next sync applies it again and no file is left on
        // disk with nothing pointing at it; the row meanwhile has nothing to serve but a 404.
        const checksums = await this.checksumsFor(room, page.items);
        const planned = this.deps.mirrors.plannedAttachmentDrops(
          room.communityRef,
          room.remoteRoomId,
          room.ownerAuthorId,
          page.items,
          checksums
        );
        await this.deleteFiles(planned);
        const applied = this.apply(room, page.items, page.nextCursor, checksums);
        if (!applied) {
          // The mirror was revoked or changed owner while the bytes were being deleted, so the
          // page was not applied: drop the rows those bytes belonged to rather than leave them
          // drawing a file that answers 404.
          if (planned.length) this.deps.mirrors.forgetAttachmentRows(planned);
        } else {
          changed = true;
          touched.add(applied.localRoomId);
          this.announce(applied);
          // A row the page dropped that the plan did not foresee (a file whose Community id was
          // recorded by a delivery during the await above) still has its bytes: delete those.
          const foreseen = new Set(planned.map((file) => file.attachmentId));
          await this.deleteFiles(
            applied.droppedAttachments.filter((file) => !foreseen.has(file.attachmentId))
          );
        }
        if (!page.hasMore) return;
      }
    } finally {
      for (const roomId of touched) eventFanOut.broadcast('room_updated', { roomId });
      if (changed) await this.scrub();
    }
  }

  /**
   * Rewrite one page into the mirror and re-index the rows it changed, in one transaction, so
   * search never answers with text the room log no longer has.
   *
   * @returns The mirror's local room and the rows that changed, or `null` when none did.
   */
  private apply(
    room: RedactionSyncRoom,
    items: NativeMirrorEntry[],
    nextCursor: string,
    checksums: ReadonlyMap<string, string>
  ): AppliedRedactions | null {
    const { db } = this.deps;
    return db.transaction(
      () => {
        const applied = this.deps.mirrors.applyRedactions(
          room.communityRef,
          room.remoteRoomId,
          room.ownerAuthorId,
          items,
          nextCursor,
          checksums
        );
        if (!applied?.changedSeqs.length) return null;
        reindexRoomEntries(db, applied.localRoomId, applied.changedSeqs);
        return applied;
      },
      { behavior: 'immediate' }
    );
  }

  /**
   * Put a committed rewrite in front of anyone looking at the room: its open windows replace the
   * changed messages in place, with the files they no longer have gone from them (the frames are
   * read back from the log after the commit). The room list and Threads re-read once the whole
   * sync is done, not once per page, since a thread's preview quotes its first message and an
   * erased author's name changes on the roster. Only ever called with a page
   * {@link RemoteMirrorStore.applyRedactions} rewrote, so the room is always a mirror. A failure
   * is logged and never undoes the rewrite: the next open of the room reads the log.
   */
  private announce(applied: AppliedRedactions): void {
    try {
      this.deps.publishRevisions?.(applied.localRoomId, applied.changedSeqs);
    } catch (error) {
      logger.warn('[communities] could not update open windows after replacing messages', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The SHA-256 of each local file these changes can only be matched on by its bytes (delivered
   * before its Community id was recorded, on a message that still has files there). A file that
   * cannot be read is left out, and a file left out is kept.
   */
  private async checksumsFor(
    room: RedactionSyncRoom,
    items: NativeMirrorEntry[]
  ): Promise<Map<string, string>> {
    const checksums = new Map<string, string>();
    const store = this.deps.attachmentBytes;
    if (!store) return checksums;
    for (const file of this.deps.mirrors.attachmentsNeedingChecksum(
      room.communityRef,
      room.remoteRoomId,
      room.ownerAuthorId,
      items
    )) {
      try {
        const stored = await store.get(
          file.roomId,
          file.attachmentId,
          file.extension,
          file.mimeType
        );
        if (!stored) continue;
        const hash = createHash('sha256');
        for await (const chunk of stored.stream) hash.update(chunk as Buffer);
        checksums.set(file.attachmentId, hash.digest('hex'));
      } catch {
        // Unreadable: no checksum, so the file is kept.
      }
    }
    return checksums;
  }

  /**
   * Delete the stored bytes of the files a redaction drops. Idempotent: a file already gone is a
   * success. Every file here was chosen by `attachmentsToDrop`, which drops a file only when the
   * Community's copy of the message no longer has it. A failure is logged and not retried by
   * this page; the row goes with the page either way, so the room stops offering the file.
   */
  private async deleteFiles(files: readonly MirrorAttachmentFile[]): Promise<void> {
    const store = this.deps.attachmentBytes;
    if (!store) return;
    for (const file of files) {
      try {
        await store.delete(file.roomId, file.attachmentId, file.extension);
      } catch (error) {
        logger.warn('[communities] could not delete a file a Community removed; retrying later', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
