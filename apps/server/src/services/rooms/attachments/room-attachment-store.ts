/**
 * Where a room's files live (spec `room-attachments` §Storage).
 *
 * `put` answers the URL the cockpit fetches from, and that is the whole seam:
 * **nothing above this interface may construct a path, join a directory, or
 * assume the bytes are local.** Today {@link LocalRoomAttachmentStore} returns a
 * server-relative `/api/rooms/<roomId>/attachments/<attachmentId>`; a
 * bucket-backed store would return an absolute `https://…` and not one route,
 * schema or renderer would change. `localPath` is the other half of that
 * honesty: it answers the real file when the bytes are on this machine and
 * `null` when they are not, which is the signal the agent projector reads to
 * decide between linking a file and fetching one.
 *
 * @module server/services/rooms/attachments/room-attachment-store
 */
import type { Readable } from 'stream';

/** A stored room attachment, ready to be piped at whoever asked for it. */
export interface StoredRoomAttachment {
  /** The bytes. A local store opens a file; a remote one opens a response. */
  stream: Readable;
  /** What the row says it is. Never re-sniffed on the way out. */
  contentType: string;
  /** A strong ETag, quotes included, derived from the content. */
  etag: string;
  /** The bytes' length, for `Content-Length`. */
  size: number;
}

/**
 * The one seam a room's files pass through.
 *
 * Ids are **opaque**: an implementation may not treat one as a path, and the
 * local one refuses any id that could be read as one. Every method is async
 * even where today's implementation could be synchronous, because the
 * implementation that motivated this interface is a network call.
 */
export interface RoomAttachmentStore {
  /**
   * Write the bytes and answer where the cockpit fetches them from.
   *
   * @param roomId - The room the file was uploaded into.
   * @param attachmentId - The opaque attachment id (a ULID today).
   * @param extension - The file suffix, without a dot. May be empty.
   * @param bytes - The file, already within the configured size limit.
   * @returns The URL to store on the attachment row.
   */
  put(
    roomId: string,
    attachmentId: string,
    extension: string,
    bytes: Buffer
  ): Promise<{ url: string }>;

  /**
   * Open one back, or `null` — including for an id that could never have had
   * one.
   *
   * @param roomId - The room the file was uploaded into.
   * @param attachmentId - The opaque attachment id.
   * @param extension - The file suffix the row recorded, without a dot.
   * @param contentType - What the row says it is; served back unexamined.
   */
  get(
    roomId: string,
    attachmentId: string,
    extension: string,
    contentType: string
  ): Promise<StoredRoomAttachment | null>;

  /**
   * The absolute path of one on this machine, or `null` when the bytes are not
   * local — the honest signal that a caller must fetch rather than link.
   *
   * @param roomId - The room the file was uploaded into.
   * @param attachmentId - The opaque attachment id.
   * @param extension - The file suffix the row recorded, without a dot.
   */
  localPath(roomId: string, attachmentId: string, extension: string): Promise<string | null>;

  /**
   * Forget one attachment's bytes. Idempotent: deleting one that is already
   * gone is a success, because the caller's intent is satisfied either way.
   *
   * The reclamation half of the port. It exists because a file can be uploaded
   * and never posted — a person who attaches something and then closes the tab
   * — and those bytes belong to nobody. `deleteRoom` used to sit here instead
   * and had no caller at all: nothing in this product deletes a room, so it was
   * scaffolding for a verb that does not exist. **When room deletion does
   * arrive it has to bring attachment cleanup with it**, and this is the method
   * it should loop over.
   *
   * @param roomId - The room the file was uploaded into.
   * @param attachmentId - The opaque attachment id.
   * @param extension - The file suffix the row recorded, without a dot.
   */
  delete(roomId: string, attachmentId: string, extension: string): Promise<void>;
}

/**
 * An id no store can file an attachment under — because it is empty, or because
 * it could be read as a path.
 *
 * Part of the contract rather than of one implementation: a store that keys on
 * anything (a filesystem, an object key, a URL segment) has ids it cannot
 * accept, and a caller needs one thing to catch. Thrown rather than returned so
 * a write can never half-happen; the route turns it into a 400.
 */
export class InvalidRoomAttachmentIdError extends Error {
  /**
   * Refuse an id, naming it.
   *
   * @param id - The id that was refused, for the log.
   */
  constructor(id: string) {
    super(`Not a usable room attachment id: ${JSON.stringify(id)}`);
    this.name = 'InvalidRoomAttachmentIdError';
  }
}
