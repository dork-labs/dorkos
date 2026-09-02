/**
 * Where a session's generated images live.
 *
 * The same seam `RoomAttachmentStore` draws for rooms, drawn again for sessions
 * and for the same reason: `put` answers the URL a client fetches from, and
 * **nothing above this interface may construct a path, join a directory, or
 * assume the bytes are local**. Today {@link LocalSessionAttachmentStore}
 * answers a server-relative `/api/sessions/<sessionId>/attachments/<id>.<ext>`;
 * a bucket-backed store would answer an absolute `https://…` and not one
 * schema, route, or renderer would change — because the URL is carried on the
 * message part verbatim rather than rebuilt from the ids.
 *
 * **The bytes never travel on the session stream.** That is the whole point of
 * storing them here. A session's events are replayed in full on every reconnect
 * and every `Last-Event-ID` catch-up, so an image inlined as base64 would be
 * re-sent on every refresh — and, because the replay buffers hold a WINDOW,
 * pictures would push the words of the turn out of it. The byte caps this
 * change added to `RingBuffer` and `EventLog` bound the damage; they do not
 * make inlining sensible, because a bounded window spent on base64 is a window
 * not spent on the transcript. A reference is a few hundred bytes; the browser
 * fetches the picture once and caches it.
 *
 * @module server/services/session/attachments/session-attachment-store
 */
import type { Readable } from 'stream';

/** A stored session image, ready to be piped at whoever asked for it. */
export interface StoredSessionAttachment {
  /** The bytes. A local store opens a file; a remote one opens a response. */
  stream: Readable;
  /** The media type the suffix maps to. Never re-sniffed on the way out. */
  contentType: string;
  /**
   * A validator for a conditional request, delimiters included. Opaque to the
   * route, which only ever compares it against `If-None-Match`. Deliberately
   * unspecified as strong-or-weak by this port: the local store answers a weak
   * `W/"<size>-<mtime>"` from one `stat`, so a 304 costs no read at all.
   */
  etag: string;
  /** The bytes' length, for `Content-Length`. */
  size: number;
}

/** What {@link SessionAttachmentStore.put} answered. */
export interface PutSessionAttachment {
  /** Where a client fetches the bytes. Carried on the part verbatim. */
  url: string;
  /** The media type the bytes were stored as (normalized to the allowlist). */
  mediaType: string;
  /** The bytes' length as stored. */
  size: number;
}

/** The one seam a session's generated images pass through. */
export interface SessionAttachmentStore {
  /**
   * Write the bytes and answer where a client fetches them from.
   *
   * **Idempotent on `attachmentId`.** Adapters derive the id deterministically
   * from the runtime's own identity for the image (see
   * `deriveSessionAttachmentId`), so reopening a session after a restart
   * re-materializes the same file at the same URL rather than minting a second
   * copy of a picture that already exists.
   *
   * @param sessionId - The DorkOS session the image belongs to.
   * @param attachmentId - The opaque, caller-derived attachment id.
   * @param mediaType - What the producer says the bytes are.
   * @param bytes - The image.
   * @throws {@link UnsupportedSessionMediaError} for a type a session may not
   *   store, or bytes past {@link MAX_SESSION_ATTACHMENT_BYTES}.
   * @throws {@link InvalidSessionAttachmentIdError} for an id that could be read
   *   as a path.
   */
  put(
    sessionId: string,
    attachmentId: string,
    mediaType: string,
    bytes: Buffer
  ): Promise<PutSessionAttachment>;

  /**
   * Open one back, or `null` — including for an id that could never have had
   * one, and for a suffix nothing here could have written.
   *
   * @param sessionId - The session the image belongs to.
   * @param attachmentId - The opaque attachment id.
   * @param extension - The stored suffix, without a dot.
   */
  get(
    sessionId: string,
    attachmentId: string,
    extension: string
  ): Promise<StoredSessionAttachment | null>;

  /**
   * Whether these bytes are already stored — the cheap half of idempotency, so
   * a history reload can skip decoding a picture it already wrote.
   *
   * @param sessionId - The session the image belongs to.
   * @param attachmentId - The opaque attachment id.
   * @param mediaType - What the producer says the bytes are.
   * @returns The prior `put`'s answer, or `null` when nothing is stored.
   */
  peek(
    sessionId: string,
    attachmentId: string,
    mediaType: string
  ): Promise<PutSessionAttachment | null>;

  /**
   * Record that this image is still in use, so retention can tell a picture
   * somebody looks at from one nobody has opened in months.
   *
   * **The sweep's safety argument depends on this method existing and being
   * called.** Retention drops files by modification time, and every other path
   * that meets an already-stored image only `stat`s it: `peek` answers from a
   * `stat` and skips the write, which is exactly the optimization that makes
   * reopening a transcript cheap — and exactly why mtime would otherwise never
   * move again after the first write. A transcript reopened every day for
   * ninety days would still have lost its picture on day ninety. So the read
   * paths say so explicitly rather than relying on a write that does not happen.
   *
   * Idempotent, best-effort, and it MUST NOT throw: a failure to refresh a
   * timestamp is not a reason to fail the request that triggered it. An
   * attachment that is not there is nothing to touch, and a success.
   *
   * @param sessionId - The session the image belongs to.
   * @param attachmentId - The opaque attachment id.
   * @param extension - The stored suffix, without a dot.
   */
  touch(sessionId: string, attachmentId: string, extension: string): Promise<void>;

  /**
   * Where the bytes for this image WOULD be fetched from, whether or not they
   * are there.
   *
   * The one read that must work for a picture that is gone. A history read
   * whose bytes cannot be re-materialized still has to project SOMETHING, or
   * the message holding only that image maps to no parts and disappears from
   * the transcript entirely — the exact defect this whole change exists to fix,
   * recreated by its own retention sweep. With a URL the reader gets the honest
   * "this image is not available" row instead of a missing turn.
   *
   * Answers `null` only for a media type this store could never have written.
   *
   * @param sessionId - The session the image belongs to.
   * @param attachmentId - The opaque attachment id.
   * @param mediaType - What the producer said the bytes are.
   */
  urlFor(sessionId: string, attachmentId: string, mediaType: string): string | null;
}

/**
 * An id no store can file an image under — because it is empty, or because it
 * could be read as a path.
 *
 * Part of the contract rather than of one implementation, for the same reason
 * its room twin is: a store that keys on anything (a filesystem, an object key,
 * a URL segment) has ids it cannot accept, and a caller needs one thing to
 * catch.
 */
export class InvalidSessionAttachmentIdError extends Error {
  /**
   * Refuse an id, naming it.
   *
   * @param id - The id that was refused, for the log.
   */
  constructor(id: string) {
    super(`Not a usable session attachment id: ${JSON.stringify(id)}`);
    this.name = 'InvalidSessionAttachmentIdError';
  }
}

/**
 * Bytes a session may not store: a media type outside the allowlist, or an
 * image past the size cap.
 *
 * Thrown rather than returned so a write can never half-happen, and carrying
 * its own sentence because the caller's job is to say what went wrong INSTEAD
 * of showing a picture — an image that silently does not appear is the exact
 * failure this whole seam exists to end.
 */
export class UnsupportedSessionMediaError extends Error {
  /**
   * Refuse bytes, saying why in words a person can read.
   *
   * @param reason - What a person is told in place of the image.
   */
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsupportedSessionMediaError';
  }
}
