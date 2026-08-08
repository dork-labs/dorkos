/**
 * Where an identity's photo lives (spec `identity-consistency` §W3.5, ADR
 * 260806-222546).
 *
 * `put` returns the URL a render cache stores — and that is the whole seam.
 * `imageUrl` is source-agnostic by construction: today {@link LocalAvatarStore}
 * returns a server-relative `/api/profile/avatar/<id>?v=<hash>`; a future
 * server- or cloud-backed store returns an absolute `https://…` and not one
 * renderer, schema or component changes. **Nothing above this interface may
 * construct a path, join a directory, or assume the bytes are local** — the
 * route hands over bytes and hands back whatever URL it is given.
 *
 * @module server/services/identity/avatar-store
 */
import type { Readable } from 'stream';

/**
 * What a profile photo may be, and how these bytes are judged — one reader for
 * the whole tree, because rooms sniff attachments with the same code
 * ({@link ./image-sniff.js}). Re-exported under the avatar names its callers
 * already use, so moving the reader changed no call site.
 */
export {
  PREVIEWABLE_IMAGE_TYPES as AVATAR_CONTENT_TYPES,
  sniffImageContentType as sniffAvatarContentType,
  type PreviewableImageType as AvatarContentType,
} from './image-sniff.js';

// The re-export above is the module's own view of the sniffer; this import is
// what the type annotations below need.
import type { PreviewableImageType as AvatarContentType } from './image-sniff.js';

/**
 * The most a photo may weigh, in bytes.
 *
 * Enforced by multer's `limits` at the route, which refuses the request while it
 * is still being read — a cap applied after the write is a disk-fill bug rather
 * than a cap. Nothing re-encodes or resizes (that needs `sharp`, and this
 * feature adds no dependency), so this number plus a `max-w` on the render is
 * the entire bound on what gets stored and served.
 */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** A stored photo, ready to be piped at whoever asked for it. */
export interface StoredAvatar {
  /** The bytes. A local store opens a file; a remote one opens a response. */
  stream: Readable;
  /** What it actually is, as decided at upload by {@link sniffAvatarContentType}. */
  contentType: string;
  /** A strong ETag, quotes included, derived from the content rather than the clock. */
  etag: string;
}

/**
 * The one seam a profile photo passes through.
 *
 * Ids are **opaque**: an implementation may not treat one as a path, and the
 * local one refuses any id that could be read as one. Every method is async even
 * where today's implementation could be synchronous, because the implementation
 * that motivated this interface is a network call.
 */
export interface AvatarStore {
  /**
   * Store `bytes` as this identity's photo, replacing whatever was there.
   *
   * @param id - The opaque identity id (an author id today).
   * @param bytes - The image, already validated and within {@link MAX_AVATAR_BYTES}.
   * @param contentType - What the bytes were sniffed to be.
   * @returns The URL to store on the identity's render cache.
   */
  put(id: string, bytes: Buffer, contentType: AvatarContentType): Promise<{ url: string }>;

  /**
   * Read an identity's photo back, or `null` when it has none — which is also
   * the answer for an id that could never have had one.
   *
   * @param id - The opaque identity id.
   */
  get(id: string): Promise<StoredAvatar | null>;

  /**
   * Forget an identity's photo. Idempotent: deleting one that is already gone is
   * a success, because the caller's intent is satisfied either way.
   *
   * @param id - The opaque identity id.
   */
  delete(id: string): Promise<void>;
}

/**
 * An id no store can file a photo under — because it is empty, or because it
 * could be read as a path.
 *
 * Part of the contract rather than of one implementation: a store that keys on
 * anything (a filesystem, an object key, a URL segment) has ids it cannot
 * accept, and a caller needs one thing to catch. Thrown rather than returned so
 * a write can never half-happen; the route turns it into a 400.
 */
export class InvalidAvatarIdError extends Error {
  /**
   * Refuse an id, naming it.
   *
   * @param id - The id that was refused, for the log.
   */
  constructor(id: string) {
    super(`Not a usable avatar id: ${JSON.stringify(id)}`);
    this.name = 'InvalidAvatarIdError';
  }
}
