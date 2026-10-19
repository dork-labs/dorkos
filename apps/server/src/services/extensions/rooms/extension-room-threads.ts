/**
 * What `api.rooms` does on the server (DOR-3017): read a room thread, reply
 * to it as the person, count and mark what they have read, and judge whether
 * a live entry belongs to a thread.
 *
 * **Two scopes, both on every call.** The room must be one the person picked
 * for this mini app ({@link isRoomAllowed}), and the person must be able to
 * read it themselves: every read goes through the room service's own
 * membership-gated reads, so a mini app never sees more than its person would.
 * A room outside either scope answers `not_found` or `room_not_allowed` before
 * anything is read.
 *
 * **Who posts is decided by the route, never here.** {@link ExtensionRoomThreads.reply}
 * takes the author the route resolved from a request that already passed the
 * posting bar (`routes/extensions-rooms-bar.ts`). Nothing in a request body
 * names an author.
 *
 * @module services/extensions/rooms/extension-room-threads
 */
import type {
  RoomAccessErrorCode,
  RoomRef,
  RoomThread,
  RoomThreadAuthor,
  RoomThreadEntry,
} from '@dorkos/extension-api';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { TurnMarks } from '../../core/turn-power/turn-marks.js';
import type { AuthorRecord, RoomService } from '../../rooms/index.js';
import { RoomError } from '../../rooms/index.js';
import type { ReadCursorService } from '../../core/read-cursor-service.js';
import { allowedRoomIds, isRoomAllowed } from './extension-room-access.js';

/**
 * The marks a mini app's reply is kept with (DOR-3017), on its row in the
 * insert's own transaction: the outsider mark. Any agent the reply wakes runs
 * at the runtime's default (`ceilingForEntry`), and a later turn with the reply
 * in view is marked (`outsiderInViewOf`), since the mini app's page can post
 * without a click and may be showing text it read from outside.
 */
export const MINI_APP_REPLY_MARKS: TurnMarks = { outsider: true };

/** Most replies a thread read returns: the newest ones. */
export const THREAD_REPLIES_MAX = 200;

/** Most threads one unread-count call takes. */
export const UNREAD_THREADS_MAX = 100;

/** A refusal `api.rooms` reports with its code. Nothing was read or written. */
export class ExtensionRoomError extends Error {
  /**
   * Refuse a call.
   *
   * @param code - Which rule refused it; the client throws it as `RoomAccessError`.
   * @param message - What went wrong, in plain words.
   */
  constructor(
    readonly code: RoomAccessErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ExtensionRoomError';
  }
}

/** The room service's refusals, as one of `api.rooms`'s codes. */
function fromRoomError(err: unknown): never {
  if (err instanceof RoomError) {
    if (err.code === 'ROOM_ARCHIVED') {
      throw new ExtensionRoomError('not_found', 'That room is archived.');
    }
    if (err.code === 'AGENT_IDENTITY_UNVERIFIED') {
      throw new ExtensionRoomError('person_required', 'Only the person can do this.');
    }
    throw new ExtensionRoomError('not_found', 'No such room or thread.');
  }
  throw err;
}

/** The read-cursor id of one thread: `<roomId>/<rootEntryId>`. */
export function threadCursorId(roomId: string, rootEntryId: string): string {
  return `${roomId}/${rootEntryId}`;
}

/** What {@link ExtensionRoomThreads} reads through, injected for tests. */
export interface ExtensionRoomThreadsDeps {
  /** The live room service. */
  rooms: () => RoomService;
  /** The live read-cursor service. */
  cursors: () => ReadCursorService;
}

/** The room side of `api.rooms`, for one request's resolved person. */
export class ExtensionRoomThreads {
  constructor(private readonly deps: ExtensionRoomThreadsDeps) {}

  /**
   * The rooms the person picked for this mini app that they can still read.
   *
   * @param extensionId - The mini app.
   * @param viewer - The person.
   */
  listRooms(extensionId: string, viewer: AuthorRecord): RoomRef[] {
    const rooms = this.deps.rooms();
    return allowedRoomIds(extensionId).flatMap((roomId) => {
      const room = this.readableRoom(rooms, roomId, viewer);
      return room ? [{ id: room.id, title: roomTitle(room) }] : [];
    });
  }

  /**
   * One thread: its root and newest replies, oldest first, with the unread count.
   *
   * @param extensionId - The mini app.
   * @param viewer - The person.
   * @param roomId - The room.
   * @param rootEntryId - The thread's root entry.
   * @throws {ExtensionRoomError} When the room is not allowed or cannot be read.
   */
  readThread(
    extensionId: string,
    viewer: AuthorRecord,
    roomId: string,
    rootEntryId: string
  ): RoomThread {
    const { room, root, replies } = this.load(extensionId, viewer, roomId, rootEntryId);
    const authors = this.authorsOf([root, ...replies]);
    return {
      roomId: room.id,
      roomTitle: roomTitle(room),
      root: toEntryView(root, authors, viewer.id),
      replies: replies.map((entry) => toEntryView(entry, authors, viewer.id)),
      unreadCount: this.countUnread(viewer, roomId, rootEntryId, replies),
    };
  }

  /**
   * Post a reply in a thread as the person.
   *
   * @param extensionId - The mini app.
   * @param viewer - The person, resolved by a route that already ran the posting bar.
   * @param roomId - The room.
   * @param rootEntryId - The thread's root entry.
   * @param text - The reply.
   * @returns The reply as stored.
   * @throws {ExtensionRoomError} When the room is not allowed, cannot be read,
   *   or is a room whose messages leave this computer.
   */
  reply(
    extensionId: string,
    viewer: AuthorRecord,
    roomId: string,
    rootEntryId: string,
    text: string
  ): RoomThreadEntry {
    const { room } = this.load(extensionId, viewer, roomId, rootEntryId);
    // A bridged room delivers what is posted to people on another app, and a
    // mirrored one to a Community server. A mini app replying as the person
    // stays on this computer, so neither is a place it may post.
    if (room.bridge || this.deps.rooms().isMirroredRoom(roomId)) {
      throw new ExtensionRoomError(
        'room_not_allowed',
        'Mini apps can only reply in rooms on this computer.'
      );
    }
    let posted: RoomEntry;
    try {
      posted = this.deps
        .rooms()
        .post(
          roomId,
          { authorId: viewer.id, text, replyTo: rootEntryId },
          false,
          { marks: MINI_APP_REPLY_MARKS }
        );
    } catch (err) {
      fromRoomError(err);
    }
    return toEntryView(posted, this.authorsOf([posted]), viewer.id);
  }

  /**
   * Unread replies per thread. Threads the person cannot read are left out.
   *
   * @param extensionId - The mini app.
   * @param viewer - The person.
   * @param roomId - The room.
   * @param rootEntryIds - The threads.
   * @throws {ExtensionRoomError} When the room is not allowed or cannot be read.
   */
  unreadCounts(
    extensionId: string,
    viewer: AuthorRecord,
    roomId: string,
    rootEntryIds: readonly string[]
  ): Record<string, number> {
    this.requireRoom(extensionId, viewer, roomId);
    const counts: Record<string, number> = {};
    for (const rootEntryId of new Set(rootEntryIds)) {
      try {
        const { replies } = this.load(extensionId, viewer, roomId, rootEntryId);
        counts[rootEntryId] = this.countUnread(viewer, roomId, rootEntryId, replies);
      } catch (err) {
        if (!(err instanceof ExtensionRoomError) || err.code !== 'not_found') throw err;
      }
    }
    return counts;
  }

  /**
   * Mark a thread read up to its newest reply. Never moves backwards.
   *
   * @param extensionId - The mini app.
   * @param viewer - The person.
   * @param roomId - The room.
   * @param rootEntryId - The thread.
   * @throws {ExtensionRoomError} When the room is not allowed or cannot be read.
   */
  markRead(extensionId: string, viewer: AuthorRecord, roomId: string, rootEntryId: string): void {
    const { root, replies } = this.load(extensionId, viewer, roomId, rootEntryId);
    const newest = replies.at(-1)?.seq ?? root.seq;
    this.deps
      .cursors()
      .advance(viewer.id, 'room-thread', threadCursorId(roomId, rootEntryId), newest);
  }

  /**
   * Check that a thread may be streamed: the same checks a read makes.
   *
   * @param extensionId - The mini app.
   * @param viewer - The person.
   * @param roomId - The room.
   * @param rootEntryId - The thread.
   * @throws {ExtensionRoomError} When the room is not allowed or cannot be read.
   */
  requireThread(
    extensionId: string,
    viewer: AuthorRecord,
    roomId: string,
    rootEntryId: string
  ): void {
    this.load(extensionId, viewer, roomId, rootEntryId);
  }

  /**
   * The view of a live entry when it is a reply in the thread, else `null`.
   *
   * @param entry - An entry the room just published.
   * @param rootEntryId - The thread being streamed.
   * @param viewerId - The person, for `isYou`.
   */
  liveReply(entry: RoomEntry, rootEntryId: string, viewerId: string): RoomThreadEntry | null {
    if (entry.threadRootEntryId !== rootEntryId) return null;
    return toEntryView(entry, this.authorsOf([entry]), viewerId);
  }

  /** The room, when it is allowed for this mini app and the person can read it. */
  private requireRoom(extensionId: string, viewer: AuthorRecord, roomId: string): RoomWithRoster {
    if (!isRoomAllowed(extensionId, roomId)) {
      throw new ExtensionRoomError(
        'room_not_allowed',
        'This mini app may not use that room. Pick it in Settings → Extensions.'
      );
    }
    const room = this.readableRoom(this.deps.rooms(), roomId, viewer);
    if (!room) throw new ExtensionRoomError('not_found', 'No such room or thread.');
    return room;
  }

  /** The room, its thread root and newest replies (oldest first). */
  private load(
    extensionId: string,
    viewer: AuthorRecord,
    roomId: string,
    rootEntryId: string
  ): { room: RoomWithRoster; root: RoomEntry; replies: RoomEntry[] } {
    const room = this.requireRoom(extensionId, viewer, roomId);
    const rooms = this.deps.rooms();
    try {
      const root = rooms.readEntry(roomId, viewer.id, rootEntryId);
      // A reply is not a thread: threads hang off top-level entries only.
      if (!root || root.threadRootEntryId !== null) {
        throw new ExtensionRoomError('not_found', 'No such room or thread.');
      }
      const replies = rooms
        .readHistory(roomId, viewer.id, {
          limit: THREAD_REPLIES_MAX,
          threadRootEntryId: rootEntryId,
        })
        .reverse();
      return { room, root, replies };
    } catch (err) {
      if (err instanceof ExtensionRoomError) throw err;
      fromRoomError(err);
    }
  }

  /** A room the person is on the roster of, or `null`. */
  private readableRoom(
    rooms: RoomService,
    roomId: string,
    viewer: AuthorRecord
  ): RoomWithRoster | null {
    try {
      const room = rooms.getRoom(roomId, viewer.id);
      if (!room || room.archived) return null;
      rooms.requireMembership(roomId, viewer.id);
      return room;
    } catch (err) {
      if (err instanceof RoomError) return null;
      throw err;
    }
  }

  /**
   * Replies from anyone but the person above where they read: the higher of
   * the room's cursor (reading the room in the app) and the thread's own.
   */
  private countUnread(
    viewer: AuthorRecord,
    roomId: string,
    rootEntryId: string,
    replies: readonly RoomEntry[]
  ): number {
    const cursors = this.deps.cursors();
    const readTo = Math.max(
      cursors.get(viewer.id, 'room', roomId)?.lastReadSeq ?? 0,
      cursors.get(viewer.id, 'room-thread', threadCursorId(roomId, rootEntryId))?.lastReadSeq ?? 0
    );
    return replies.filter((entry) => entry.seq > readTo && entry.authorId !== viewer.id).length;
  }

  /** Every author these entries name, in one read. */
  private authorsOf(entries: readonly RoomEntry[]): Map<string, AuthorRecord> {
    return this.deps.rooms().authorRegistry.getMany([...new Set(entries.map((e) => e.authorId))]);
  }
}

/** What a person calls a room: `#slug` for a channel, the title otherwise. */
function roomTitle(room: { kind: string; slug: string | null; title: string }): string {
  return room.kind === 'channel' && room.slug ? `#${room.slug}` : room.title;
}

/** One entry as a mini app sees it. */
function toEntryView(
  entry: RoomEntry,
  authors: ReadonlyMap<string, AuthorRecord>,
  viewerId: string
): RoomThreadEntry {
  const record = authors.get(entry.authorId);
  const author: RoomThreadAuthor = {
    id: entry.authorId,
    name: record?.displayName ?? 'Someone',
    kind: record?.kind === 'agent' ? 'agent' : record?.kind === 'human' ? 'person' : 'system',
    isYou: entry.authorId === viewerId,
  };
  return {
    id: entry.id,
    seq: entry.seq,
    author,
    createdAt: entry.createdAt,
    text: entry.body.text,
  };
}
