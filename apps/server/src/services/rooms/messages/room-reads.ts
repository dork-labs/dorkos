/**
 * Reading a room's log: the cockpit's page, the agent's history tool, the SSE
 * snapshot and replay, and the whole-room export.
 *
 * Every one of them goes out through {@link RoomProjection.withRollups}, so a
 * reader never holds an entry without the reactions and files that hang off
 * it, and every one of them is gated on membership rather than visibility —
 * reading a room's log is a membership, even for the owner.
 *
 * @module server/services/rooms/messages/room-reads
 */
import type { RoomEntry, RoomEntryListResponse, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomExportLine } from '@dorkos/shared/room-export-schemas';
import { SERVER_VERSION } from '../../../lib/version.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomCore } from '../service/room-core.js';
import { buildRoomExport, createExportAuthorResolver } from '../room-export.js';
import type { RoomProjection } from '../service/room-projection.js';
import type { RoomRoster } from '../room-roster.js';
import type { RoomStore } from '../room-store.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/**
 * The most entries either history tool will return in one page
 * (room-participation spec §10.3).
 *
 * **A clamp, never a refusal.** An agent that asks for a thousand messages is not
 * making an error a `400` would teach it anything about; it wants as much as it
 * can have, and the useful answer is the most that is sensible plus a cursor to
 * ask again with. Two hundred is roughly a long afternoon in a busy channel and
 * still a page a model can hold.
 */
export const HISTORY_PAGE_MAX = 200;

/**
 * Bring a requested page size inside {@link HISTORY_PAGE_MAX}, and above zero.
 *
 * @param limit - What the caller asked for.
 * @returns A page size the store will accept.
 */
export function clampHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return HISTORY_PAGE_MAX;
  return Math.min(HISTORY_PAGE_MAX, Math.max(1, Math.floor(limit)));
}

/** Every way a room's own log is read back. */
export class RoomReads {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  private readonly roster: RoomRoster;
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly projection: RoomProjection
  ) {
    this.store = core.store;
    this.authors = core.authors;
    this.roster = core.roster;
    this.isOwnerAuthor = core.isOwnerAuthor;
  }

  /**
   * A page of history, oldest-first.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param opts.before - Return entries with `seq` below this.
   * @param opts.limit - Page size.
   */
  listEntries(
    roomId: string,
    viewerAuthorId: string,
    opts: { before?: number; limit: number }
  ): RoomEntry[] {
    this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    return this.projection.withRollups(roomId, this.store.listEntries(roomId, opts));
  }

  /**
   * A page of history together with the thread roots it points OUTSIDE itself —
   * what a reader needs to draw the page as threads (DOR-690).
   *
   * **A thread is a relation between entries** (ADR 260728-022013), so a reply
   * is only legible as a reply while the entry heading its thread is loaded
   * beside it. A page is the room's trailing window, and a thread outlives one:
   * the default page is 50 entries, so any thread whose root is older than that
   * arrived as a run of flat rows with nothing saying they answered anything —
   * and the busier the room, the sooner it happened.
   *
   * **The page fetches them, rather than the reader asking a second time.** The
   * alternative — the client collecting the ids it is missing and calling back
   * — costs a round trip on the render path and a second cache beside the one
   * the room's live stream owns, to answer a question this call already has the
   * rows for. Here it is one indexed read by id, bounded by the page size,
   * skipped entirely when the page is self-contained.
   *
   * **No root reaches a reader that the page itself could not have.** They are
   * read by id from THIS room, and the gate above them is the same
   * `requireVisibleRoom` the page passed — the same rows `before=` would have
   * served this caller anyway, one page further back.
   *
   * **Each root carries its true reply count, and only these roots do.** A
   * thread that reaches back past the page is the one whose replies the page
   * cannot hold all of, so it is the one place where counting what came back
   * would understate the thread — the room would say "50 replies" beside a
   * Threads list saying 60. A root inside the page needs no such number: every
   * reply is written after it and the page runs to the newest entry, so what
   * the reader has IS the thread ({@link RoomEntry.threadReplyCount}).
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param opts.before - Return entries with `seq` below this.
   * @param opts.limit - Page size. Bounds the page, and with it the roots.
   * @returns The page, and the roots it references but does not contain — each
   *   one older than the page's own oldest entry, since a root the page's seq
   *   range covers is already in the page.
   */
  listEntryPage(
    roomId: string,
    viewerAuthorId: string,
    opts: { before?: number; limit: number }
  ): RoomEntryListResponse {
    const entries = this.listEntries(roomId, viewerAuthorId, opts);
    const paged = new Set(entries.map((entry) => entry.id));
    const missing = new Set<string>();
    for (const entry of entries) {
      // The SCOPE before the RELATION, exactly as the client's own placement
      // reads it (`threadRootIdOf`): grouping is by the entry heading the
      // thread, so a root resolved from anything else is a row the timeline
      // would never hang this reply under.
      const rootId = entry.threadRootEntryId ?? entry.parentEntryId;
      if (rootId !== null && !paged.has(rootId)) missing.add(rootId);
    }
    if (missing.size === 0) return { entries, threadRoots: [] };
    const wanted = [...missing];
    const sizes = this.store.countThreadRepliesFor(roomId, wanted);
    return {
      entries,
      threadRoots: this.projection
        .withRollups(roomId, this.store.listEntriesByIds(roomId, wanted))
        .map((root) => ({
          ...root,
          // Never absent in practice — a root is only in this list because a
          // reply in the page pointed at it — but read defensively rather than
          // asserted, because the fallback is the count the reader would have
          // been given anyway and a throw here would cost them the whole room.
          threadReplyCount: sizes.get(root.id)?.replyCount,
        })),
    };
  }

  /**
   * A page of one room's history for a member, newest first — `read_room_history`
   * (room-participation spec §10.3).
   *
   * **One predicate over one table**, because a thread is an entry-level relation:
   * `room_id`, the caller's join point, and optionally one `thread_root_entry_id`.
   *
   * Three scope rules, and they are the same three the room's own read paths
   * already keep:
   *
   * - **Members only.** {@link RoomVisibility.requireVisibleRoom} plus an explicit
   *   membership check, so seeing a room is still not being in it.
   * - **A room id is not a capability.** "Not a member" and "no such room" are the
   *   same `ROOM_NOT_FOUND`, so a probe learns nothing.
   * - **Never below `joinedSeq`.** A member does not retroactively read what was
   *   said before they arrived (spec §8.3). Strictly above, matching the ambient
   *   window's own floor.
   *
   * `limit` is CLAMPED rather than refused: an agent that asks for a thousand gets
   * {@link HISTORY_PAGE_MAX}, because refusing a number is a worse answer than
   * giving the most that is sensible.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param opts.limit - How many entries to return, clamped to
   *   {@link HISTORY_PAGE_MAX}.
   * @param opts.before - Return entries with `seq` strictly below this, for paging
   *   backwards.
   * @param opts.threadRootEntryId - Narrow to one thread's replies.
   * @returns The page, newest first.
   */
  readHistory(
    roomId: string,
    viewerAuthorId: string,
    opts: { limit: number; before?: number; threadRootEntryId?: string }
  ): RoomEntry[] {
    const { floor } = this.visibility.requireHistoryFloor(roomId, viewerAuthorId);
    const page = this.store.listEntries(roomId, {
      afterSeq: floor,
      limit: clampHistoryLimit(opts.limit),
      ...(opts.before !== undefined ? { before: opts.before } : {}),
      ...(opts.threadRootEntryId !== undefined
        ? { threadRootEntryId: opts.threadRootEntryId }
        : {}),
    });
    // The store answers oldest-first within the page; the tool's contract is
    // newest-first, which is the order an agent reading back wants.
    return this.projection.withRollups(roomId, page).reverse();
  }

  /**
   * A room's whole history as JSONL — `GET /api/rooms/:id/export` (DOR-1225).
   *
   * Rooms live only in SQLite, and this is the projection that pays back what
   * that costs them: a file you can grep, copy, and keep. **It is a copy and
   * never a sync target** — nothing reads one back in, and this method touches
   * no writer, so the database stays the truth.
   *
   * **A generator, because a room's log is never trimmed.** The lines come out
   * one at a time and the route writes each as it arrives, so a ten-year channel
   * is never assembled in memory before the download can start. That is also why
   * the header cannot state a count and why the last line is a `summary`: a
   * truncated download is otherwise a perfectly valid file of the messages that
   * made it, with nothing inside it saying so.
   *
   * **Membership is the gate**, exactly as it is for `read_room_history`: the
   * same {@link RoomVisibility.requireHistoryFloor} both history tools use, so
   * seeing a room is still not being in it and "not a member" answers exactly as
   * "no such room".
   *
   * **The join floor is NOT applied to the operator exporting their own room**,
   * and that is the one deliberate difference from those tools. The floor exists
   * so a member does not retroactively read what was said before they arrived —
   * a rule about one participant's view of a shared conversation. An export is
   * not a view: it is the exit path (the community exit promise, DOR-596 C2),
   * and an owner handed a copy of their own room with the first months missing
   * has not been given their data. Everybody else — every agent, and any second
   * person — exports strictly above their own `joinedSeq`, and the file says
   * which of the two it is in `scope.joinFloorApplied` rather than leaving a
   * reader to guess from where the seqs start.
   *
   * **What this method owns is the two questions only the service can answer** —
   * who may export, and how much of the room they get. The file's shape, its
   * paging and its receipt live in `room-export.ts`, which is handed the answers
   * and never reaches back for a store.
   *
   * @param roomId - The room to copy.
   * @param viewerAuthorId - Who is asking; must be on the roster.
   * @yields The header, then every entry in ascending `seq`, then the summary.
   */
  *exportRoom(roomId: string, viewerAuthorId: string): Generator<RoomExportLine> {
    const { room, floor } = this.visibility.requireHistoryFloor(roomId, viewerAuthorId);
    const wholeRoom = this.isOwnerAuthor(viewerAuthorId);
    const resolve = createExportAuthorResolver((authorId) => this.authors.getById(authorId));

    yield* buildRoomExport({
      room,
      members: this.roster.list(roomId),
      exportedBy: resolve(viewerAuthorId),
      exportedAt: new Date().toISOString(),
      dorkosVersion: SERVER_VERSION,
      scope: { fromSeq: wholeRoom ? 0 : floor, joinFloorApplied: !wholeRoom },
      resolve,
      page: (afterSeq, limit) =>
        this.projection.withRollups(
          roomId,
          this.store.listEntriesForExport(roomId, { afterSeq, limit })
        ),
    });
  }

  /**
   * The snapshot a cold SSE connect opens with, plus the cursor its live
   * subscription resumes from.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param historyLimit - How many trailing entries to hydrate with.
   */
  snapshot(
    roomId: string,
    viewerAuthorId: string,
    historyLimit: number
  ): { room: RoomWithRoster; entries: RoomEntry[]; cursor: number } {
    const room = this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    const entries = this.projection.withRollups(
      roomId,
      this.store.listEntries(roomId, { limit: historyLimit })
    );
    return {
      room: this.projection.withRoster(room, viewerAuthorId),
      entries,
      cursor: entries.length > 0 ? entries[entries.length - 1].seq : 0,
    };
  }

  /**
   * The highest `seq` this room has issued, or 0 when it is empty. The SSE
   * handler bounds a resume cursor against it.
   *
   * @param roomId - The room.
   */
  maxSeq(roomId: string): number {
    return this.store.maxSeq(roomId);
  }

  /**
   * Every entry after a cursor — the SSE replay read. The log is never trimmed,
   * so this is always servable.
   *
   * @param roomId - The room.
   * @param afterSeq - Return entries with `seq` above this.
   */
  entriesAfter(roomId: string, afterSeq: number): RoomEntry[] {
    return this.projection.withRollups(roomId, this.store.listEntriesAfter(roomId, afterSeq));
  }

  /**
   * How many turns each author has already taken in one cascade — the repeat
   * rule's input, read here so R3's trigger path does not have to know the
   * schema. See {@link RoomStore.turnsByAuthorInCascade} for what a turn is.
   *
   * @param roomId - The room.
   * @param cascadeRoot - The entry id that began the cascade.
   */
  turnsByAuthorInCascade(roomId: string, cascadeRoot: string): Map<string, number> {
    return this.store.turnsByAuthorInCascade(roomId, cascadeRoot);
  }
}
