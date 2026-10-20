/**
 * Reading and replying in a room thread from a mini app's page, as the
 * signed-in person (`api.rooms`, DOR-3017): the shapes it reads, the one error
 * it throws, and the API itself.
 *
 * Plain types and one error class with no runtime dependencies, so an
 * extension bundle can import it.
 *
 * **Scoped twice.** A mini app reaches only the rooms the person picked for it
 * in Settings → Extensions, and inside those only what the person can read
 * themselves. With no rooms picked, or no `capabilities.rooms` in its
 * manifest, it reaches nothing.
 *
 * @module @dorkos/extension-api/room-threads
 */

/** Who wrote an entry. */
export interface RoomThreadAuthor {
  /** The author's id in this room. Stable; the same for every entry they write. */
  readonly id: string;
  /** Their name as the room shows it. */
  readonly name: string;
  /**
   * `person` for a human (the person signed in, or someone on a connected chat
   * app), `agent` for an agent, `system` for DorkOS's own notices.
   */
  readonly kind: 'person' | 'agent' | 'system';
  /** True when this is the person signed in to DorkOS: "you". */
  readonly isYou: boolean;
}

/** One message in a thread: its root, or a reply under it. */
export interface RoomThreadEntry {
  /** The entry's id. A thread is addressed by its root's id. */
  readonly id: string;
  /** Its place in the room, increasing. Later entries have a higher number. */
  readonly seq: number;
  /** Who wrote it. */
  readonly author: RoomThreadAuthor;
  /** ISO-8601 time it was written. */
  readonly createdAt: string;
  /** What it says, as markdown. Empty for an entry that carried only files. */
  readonly text: string;
}

/** A thread: its root message and the replies under it, oldest first. */
export interface RoomThread {
  /** The room it is in. */
  readonly roomId: string;
  /** The room's name, such as `#marketing`. */
  readonly roomTitle: string;
  /** The message the thread hangs off. */
  readonly root: RoomThreadEntry;
  /** The newest replies, oldest first (at most 200). */
  readonly replies: readonly RoomThreadEntry[];
  /**
   * Replies from anyone but you that you have not read. Reading the room in
   * DorkOS counts, and so does {@link ExtensionRoomsApi.markRead}.
   */
  readonly unreadCount: number;
}

/** A room this mini app may use, as {@link ExtensionRoomsApi.listRooms} reads it. */
export interface RoomRef {
  /** The room's id. */
  readonly id: string;
  /** Its name, such as `#marketing`. */
  readonly title: string;
}

/** Why `api.rooms` refused a call. See {@link RoomAccessError}. */
export type RoomAccessErrorCode =
  /** The person has not picked this room for this mini app. */
  | 'room_not_allowed'
  /** No such room or thread, or the person cannot read it. */
  | 'not_found'
  /** Posting needs the person, in their own window of the app. */
  | 'person_required'
  /** The mini app is turned off. */
  | 'extension_off'
  /** The call broke a rule (empty text, too long). */
  | 'invalid_input'
  /** DorkOS could not answer. Try again. */
  | 'unavailable';

/**
 * A call `api.rooms` refused, with nothing written. `message` is plain words,
 * safe to show as it is. Match on `err.code` rather than `instanceof`: an
 * extension bundle carries its own copy of this class.
 */
export class RoomAccessError extends Error {
  /** Which rule refused the call. */
  readonly code: RoomAccessErrorCode;

  /**
   * Refuse a call.
   *
   * @param code - Which rule refused it.
   * @param message - What went wrong, in plain words.
   */
  constructor(code: RoomAccessErrorCode, message: string) {
    super(message);
    this.name = 'RoomAccessError';
    this.code = code;
  }
}

/** Longest reply `api.rooms.reply` takes, in characters. */
export const ROOM_THREAD_REPLY_MAX_CHARS = 20_000;

/**
 * The `api.rooms` surface: read a thread, reply to it as the person, keep
 * track of what they have read, and hear new replies. Probe with
 * `api.rooms !== undefined` to run on hosts from before it.
 *
 * Every method throws {@link RoomAccessError} on refusal.
 *
 * @example
 * ```ts
 * const thread = await api.rooms.readThread(roomId, post.threadId);
 * const stop = api.rooms.subscribeThread(roomId, post.threadId, (entry) => {
 *   setReplies((list) => [...list, entry]);
 * });
 * await api.rooms.reply(roomId, post.threadId, 'Looks good');
 * ```
 */
export interface ExtensionRoomsApi {
  /** The rooms the person picked for this mini app that they can still read. */
  listRooms(): Promise<RoomRef[]>;
  /**
   * One thread: the root and its newest replies, oldest first.
   *
   * @param roomId - The room.
   * @param rootEntryId - The id of the message the thread hangs off.
   */
  readThread(roomId: string, rootEntryId: string): Promise<RoomThread>;
  /**
   * Reply in a thread as the person signed in. The reply is theirs: it shows
   * under their name, and mentions wake agents as if they had typed it. It
   * is recorded in the audit trail with this mini app named.
   *
   * Only works from the person's own window of the app. An agent, a request
   * from another site or relayed from somewhere, and a server half running in
   * its own process are refused with `person_required`.
   *
   * @param roomId - The room.
   * @param rootEntryId - The thread.
   * @param text - Markdown, 1 to {@link ROOM_THREAD_REPLY_MAX_CHARS} characters.
   * @returns The reply as stored.
   */
  reply(roomId: string, rootEntryId: string, text: string): Promise<RoomThreadEntry>;
  /**
   * How many unread replies each thread has: the replies from anyone but the
   * person above where they last read.
   *
   * @param roomId - The room.
   * @param rootEntryIds - The threads, at most 100. Unknown ids are left out.
   * @returns A count per thread id.
   */
  unreadCounts(roomId: string, rootEntryIds: readonly string[]): Promise<Record<string, number>>;
  /**
   * Mark a thread read up to its newest reply. Never moves backwards.
   *
   * @param roomId - The room.
   * @param rootEntryId - The thread.
   */
  markRead(roomId: string, rootEntryId: string): Promise<void>;
  /**
   * Hear each new reply in a thread as it is written, yours included. Also
   * delivers replies written while the connection was down, once it is back.
   * Stops by itself when the person takes the room away from this mini app.
   *
   * @param roomId - The room.
   * @param rootEntryId - The thread.
   * @param listener - Called once per new reply.
   * @returns A function that stops listening. Called automatically when the
   *   mini app deactivates.
   */
  subscribeThread(
    roomId: string,
    rootEntryId: string,
    listener: (entry: RoomThreadEntry) => void
  ): () => void;
}
