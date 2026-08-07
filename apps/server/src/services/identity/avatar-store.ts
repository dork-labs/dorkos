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
 * What a profile photo may be.
 *
 * Three raster formats every browser renders, and nothing else. SVG is absent
 * on purpose: it is a script vector, and `routes/files.ts` needs a bespoke CSP
 * sandbox to serve one safely — a thing a profile photo has no reason to need.
 */
export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** One of {@link AVATAR_CONTENT_TYPES}. */
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

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

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * What these bytes actually are, or `null` when they are not a photo DorkOS
 * accepts.
 *
 * **The only evidence considered is the content.** A filename and a
 * `Content-Type` header are both written by whoever is uploading, so a `.png`
 * carrying a GIF, or an SVG announced as `image/png`, is exactly the case this
 * exists to catch. WebP needs both ends of its RIFF header read — `RIFF` alone
 * is also a WAV and an AVI.
 *
 * Bytes too short to carry a signature match nothing, with no length guard
 * needed: a truncated buffer's `subarray` is shorter than the magic it is
 * compared against, and a `toString` past its end returns less than it asked
 * for.
 *
 * @param bytes - The uploaded file, or at least its first twelve bytes.
 */
export function sniffAvatarContentType(bytes: Buffer): AvatarContentType | null {
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
