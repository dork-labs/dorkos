/**
 * The only {@link SessionAttachmentStore} implementation today: a session's
 * generated images on this machine, under the DorkOS data directory.
 *
 * `<dorkHome>/sessions/<sessionId>/attachments/<attachmentId>.<ext>`, where
 * `dorkHome` is the value `resolveDorkHome()` produced at startup and handed to
 * the constructor — **never the operating system's home directory**, which is
 * banned in `apps/server/src` outside the carve-outs in Hard Rule 3
 * (`.claude/rules/dork-home.md`). Per-install and durable, like its room
 * counterpart, and for the same reason: a picture in a transcript has to still
 * be there when the transcript is reopened next week.
 *
 * **The filename is the whole record.** The suffix names the media type (via the
 * bijection in `session-media-types.ts`), `stat` gives the size, and the parent
 * directory names the owning session — so there is no row, no migration, and
 * nothing that can fall out of sync with the bytes. See that module for why a
 * session attachment can afford this and a room attachment cannot.
 *
 * @module server/services/session/attachments/local-session-attachment-store
 */
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, rename, stat, utimes, writeFile } from 'fs/promises';
import path from 'path';
import {
  InvalidSessionAttachmentIdError,
  UnsupportedSessionMediaError,
  type PutSessionAttachment,
  type SessionAttachmentStore,
  type StoredSessionAttachment,
} from './session-attachment-store.js';
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  displayableMime,
  imageMediaTypeForExtension,
  storableImageExtension,
} from './session-media-types.js';

/**
 * The characters a session id or an attachment id may be made of.
 *
 * The same allowlist `LocalRoomAttachmentStore` uses, and an allowlist rather
 * than an escape for the same reason: both ids reach this module from a URL
 * path segment, and the only safe way to know a string is not a path is that it
 * cannot contain one. Session ids are UUIDs and attachment ids are hex digests,
 * which live comfortably inside this.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A session's generated images on this machine's disk. */
export class LocalSessionAttachmentStore implements SessionAttachmentStore {
  private readonly root: string;

  /**
   * Bind the store to one install's data directory.
   *
   * @param dorkHome - The resolved DorkOS data directory. Required, with no
   *   fallback, per `.claude/rules/dork-home.md`.
   */
  constructor(dorkHome: string) {
    this.root = path.join(dorkHome, 'sessions');
  }

  /**
   * Write the bytes and answer the URL a client fetches them from.
   *
   * Refuses before it writes: a type outside the allowlist and a picture past
   * the cap both throw {@link UnsupportedSessionMediaError}, whose message is
   * what a person is shown INSTEAD of the image. Nothing is truncated — half a
   * PNG is not a smaller PNG.
   *
   * The write lands via a uniquely-named temp file and a rename, so an
   * interrupted write never leaves a truncated file where a whole one was, and
   * two writers racing the same deterministic id cannot stage over each other.
   *
   * @param sessionId - The session the image belongs to.
   * @param attachmentId - The caller-derived attachment id.
   * @param mediaType - What the producer says the bytes are.
   * @param bytes - The image.
   */
  async put(
    sessionId: string,
    attachmentId: string,
    mediaType: string,
    bytes: Buffer
  ): Promise<PutSessionAttachment> {
    const { extension, normalized } = this.requireStorable(mediaType);
    if (bytes.byteLength > MAX_SESSION_ATTACHMENT_BYTES) {
      throw new UnsupportedSessionMediaError(
        `That image is ${formatMib(bytes.byteLength)} — larger than the ${formatMib(
          MAX_SESSION_ATTACHMENT_BYTES
        )} a session will store.`
      );
    }
    const file = this.fileFor(sessionId, attachmentId, extension);
    await mkdir(path.dirname(file), { recursive: true });
    const staged = `${file}.${randomUUID()}.tmp`;
    await writeFile(staged, bytes);
    await rename(staged, file);
    return {
      url: attachmentUrl(sessionId, attachmentId, extension),
      mediaType: normalized,
      size: bytes.byteLength,
    };
  }

  /**
   * Open one back, or answer `null` — which covers "no such file", "no such
   * session", "that id is not one an attachment could have", and "nothing here
   * writes that suffix".
   *
   * **The bytes are streamed, never buffered**, and the validator comes from
   * one `stat`, so serving a 200 costs no extra read and answering a 304 costs
   * no read at all. The content type comes from the suffix, never from
   * sniffing: the suffix is one this store wrote, and it wrote it only for a
   * type on the allowlist.
   *
   * @param sessionId - The session the image belongs to.
   * @param attachmentId - The attachment id.
   * @param extension - The stored suffix, without a dot.
   */
  async get(
    sessionId: string,
    attachmentId: string,
    extension: string
  ): Promise<StoredSessionAttachment | null> {
    const contentType = imageMediaTypeForExtension(extension);
    if (!contentType) return null;
    const file = this.safeFileOrNull(sessionId, attachmentId, extension);
    if (!file) return null;
    const info = await statIfPresent(file);
    if (!info) return null;
    return {
      stream: createReadStream(file),
      contentType,
      etag: weakEtag(attachmentId, info.size),
      size: info.size,
    };
  }

  /**
   * What a prior `put` answered for these bytes, or `null` when nothing is
   * stored — the cheap half of idempotency.
   *
   * A `stat`, not a read: the caller wants to know whether to bother decoding a
   * picture, and reading the whole file to answer that would cost more than the
   * decode it saves.
   *
   * @param sessionId - The session the image belongs to.
   * @param attachmentId - The attachment id.
   * @param mediaType - What the producer says the bytes are.
   */
  async peek(
    sessionId: string,
    attachmentId: string,
    mediaType: string
  ): Promise<PutSessionAttachment | null> {
    const extension = storableImageExtension(mediaType);
    if (!extension) return null;
    const file = this.safeFileOrNull(sessionId, attachmentId, extension);
    if (!file) return null;
    const info = await statIfPresent(file);
    if (!info) return null;
    return {
      url: attachmentUrl(sessionId, attachmentId, extension),
      mediaType: imageMediaTypeForExtension(extension) ?? mediaType,
      size: info.size,
    };
  }

  /**
   * Push this image's modification time to now, so retention reads it as in use.
   *
   * `utimes`, not a rewrite: the bytes are identical and content-addressed, so
   * rewriting them would burn the whole file to move one timestamp. Every
   * failure is swallowed — the caller is serving a request, and a stale mtime
   * costs at worst one swept picture in ninety days, while a thrown error here
   * would cost the response.
   *
   * @param sessionId - The session the image belongs to.
   * @param attachmentId - The attachment id.
   * @param extension - The stored suffix, without a dot.
   */
  async touch(sessionId: string, attachmentId: string, extension: string): Promise<void> {
    const file = this.safeFileOrNull(sessionId, attachmentId, extension);
    if (!file) return;
    const now = new Date();
    try {
      await utimes(file, now, now);
    } catch {
      // Gone, unreadable, or on a filesystem that will not have it. Not worth
      // a word: the next sweep is ninety days away.
    }
  }

  /**
   * Where these bytes would be fetched from, whether or not they exist.
   *
   * Deliberately does NOT touch the disk — the one caller that needs it is
   * asking precisely because the file is missing.
   *
   * @param sessionId - The session the image belongs to.
   * @param attachmentId - The attachment id.
   * @param mediaType - What the producer said the bytes are.
   */
  urlFor(sessionId: string, attachmentId: string, mediaType: string): string | null {
    const extension = storableImageExtension(mediaType);
    if (!extension) return null;
    if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(attachmentId)) return null;
    return attachmentUrl(sessionId, attachmentId, extension);
  }

  /**
   * The allowlisted suffix and canonical type for these bytes, or refuse them.
   *
   * The refusal message reaches a person — it rides out of the live turn as a
   * rendered error — and `mediaType` is producer-controlled, so it is shown
   * through `displayableMime` rather than raw. This is the same sanitization
   * the history placeholder for this condition applies, so both surfaces of one
   * turn say the same safe thing.
   *
   * @param mediaType - What the producer said the bytes are.
   */
  private requireStorable(mediaType: string): { extension: string; normalized: string } {
    const extension = storableImageExtension(mediaType);
    if (!extension) {
      const shown = mediaType.trim() ? displayableMime(mediaType) : 'an untyped file';
      throw new UnsupportedSessionMediaError(
        `A session cannot store ${shown} — only PNG, JPEG, GIF and WebP images.`
      );
    }
    return { extension, normalized: imageMediaTypeForExtension(extension) ?? mediaType };
  }

  /** Where one session's images live, refusing a session id that could be a path. */
  private dirFor(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw new InvalidSessionAttachmentIdError(sessionId);
    const dir = path.resolve(this.root, sessionId, 'attachments');
    if (path.dirname(path.dirname(dir)) !== path.resolve(this.root)) {
      throw new InvalidSessionAttachmentIdError(sessionId);
    }
    return dir;
  }

  /**
   * The path this image lives at, refusing anything that could reach outside its
   * session's directory. The same double guard the room store makes: refuse the
   * id by its characters, then prove the resolved path is still inside.
   */
  private fileFor(sessionId: string, attachmentId: string, extension: string): string {
    const dir = this.dirFor(sessionId);
    if (!SAFE_ID.test(attachmentId)) throw new InvalidSessionAttachmentIdError(attachmentId);
    const file = path.resolve(dir, `${attachmentId}.${extension}`);
    if (path.dirname(file) !== dir) throw new InvalidSessionAttachmentIdError(attachmentId);
    return file;
  }

  /**
   * {@link LocalSessionAttachmentStore.fileFor} for the read paths, where an
   * unusable id is simply nothing to read rather than an error — the same
   * asymmetry the room store draws between `get` and `put`.
   */
  private safeFileOrNull(
    sessionId: string,
    attachmentId: string,
    extension: string
  ): string | null {
    if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(attachmentId)) return null;
    if (!imageMediaTypeForExtension(extension)) return null;
    return this.fileFor(sessionId, attachmentId, extension);
  }
}

/**
 * Where a client fetches one image from.
 *
 * The suffix rides IN the URL, and that is what makes the row unnecessary: the
 * serving route reads the media type straight off the path it was given instead
 * of looking one up.
 *
 * @param sessionId - The session the image belongs to.
 * @param attachmentId - The attachment id.
 * @param extension - The stored suffix, without a dot.
 */
function attachmentUrl(sessionId: string, attachmentId: string, extension: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(
    `${attachmentId}.${extension}`
  )}`;
}

/** Bytes as mebibytes, for a sentence a person reads. */
function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The validator a conditional request compares against: the attachment id and
 * the byte length, weak.
 *
 * **Deliberately NOT mtime**, which is the obvious choice and the wrong one
 * here. Retention reads modification time to decide what is still in use, so
 * the read paths push it forward on purpose (`touch`) — which would change an
 * mtime-derived ETag on every fetch and turn every conditional request into a
 * full re-download. The two mechanisms would have quietly cancelled each other
 * out, and a caching test is how that surfaced.
 *
 * The id is the right input instead: an attachment is written once under an id
 * derived from its content's identity and never rewritten with different bytes,
 * so the id plus the length identifies the representation exactly as well as a
 * timestamp did — and it is stable under the touching the sweep depends on.
 * Weak because it is honest: this is not a byte-for-byte hash.
 */
function weakEtag(attachmentId: string, size: number): string {
  return `W/"${attachmentId}-${size.toString(16)}"`;
}

/** The file's size and mtime, or `null` when it is not there. */
async function statIfPresent(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(file);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
