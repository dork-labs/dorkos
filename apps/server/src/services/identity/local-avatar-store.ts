/**
 * The only {@link AvatarStore} implementation today: photos on this machine,
 * under the DorkOS data directory.
 *
 * `<dorkHome>/avatars/<id>.<ext>`, where `dorkHome` is the value
 * `resolveDorkHome()` produced at startup — **never `os.homedir()`**, which is
 * banned in `apps/server/src` outside three carve-outs (Hard Rule 3,
 * `.claude/rules/dork-home.md`), and never the upload directory either:
 * `UploadHandler.getUploadDir(cwd)` is `{cwd}/.dork/.temp/uploads`, which is
 * per-project and temporary. A profile photo is per-install and permanent.
 *
 * @module server/services/identity/local-avatar-store
 */
import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import path from 'path';
import {
  AVATAR_CONTENT_TYPES,
  InvalidAvatarIdError,
  type AvatarContentType,
  type AvatarStore,
  type StoredAvatar,
} from './avatar-store.js';

/** The file suffix each accepted type is stored under. */
const EXTENSIONS: Record<AvatarContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** The reverse of {@link EXTENSIONS} — what a file on disk is served as. */
const CONTENT_TYPE_BY_EXTENSION = new Map<string, AvatarContentType>(
  AVATAR_CONTENT_TYPES.map((type) => [EXTENSIONS[type], type])
);

/**
 * How much of the content hash rides in the URL and the ETag.
 *
 * 64 bits of SHA-256, which is far past the point where two of one person's own
 * photos could collide, and short enough to read in a URL.
 */
const HASH_LENGTH = 16;

/**
 * The characters an avatar id may be made of.
 *
 * An allowlist rather than an escape: ids reach this module from a URL path
 * segment, and the only safe way to know a string is not a path is that it
 * cannot contain one. Author ids are ULIDs and mesh agent ids are
 * `agent-<name>`, both of which live comfortably inside this.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Photos on this machine's disk. */
export class LocalAvatarStore implements AvatarStore {
  private readonly dir: string;

  /**
   * Bind the store to one install's data directory.
   *
   * @param dorkHome - The resolved DorkOS data directory. Required, with no
   *   fallback, per `.claude/rules/dork-home.md`.
   */
  constructor(dorkHome: string) {
    this.dir = path.join(dorkHome, 'avatars');
  }

  /**
   * Write the photo, replacing whatever this identity had — including a photo in
   * a different format, whose file this removes rather than leaving beside the
   * new one for the next read to pick between.
   *
   * The write lands via a uniquely-named temp file and a rename, so a reader
   * never sees a half-written photo and two uploads racing cannot stage over
   * each other. The old format is dropped BEFORE the rename rather than after,
   * so an interruption leaves one photo or none — never two files whose order
   * on disk decides which face this person has.
   *
   * @param id - The identity id.
   * @param bytes - The validated image.
   * @param contentType - What the bytes were sniffed to be.
   */
  async put(id: string, bytes: Buffer, contentType: AvatarContentType): Promise<{ url: string }> {
    const extension = EXTENSIONS[contentType];
    const file = this.fileFor(id, extension);
    await mkdir(this.dir, { recursive: true });
    const staged = `${file}.${randomUUID()}.tmp`;
    await writeFile(staged, bytes);
    await this.removeExcept(id, extension);
    await rename(staged, file);
    return { url: `/api/profile/avatar/${encodeURIComponent(id)}?v=${hashOf(bytes)}` };
  }

  /**
   * Open this identity's photo, or answer `null` — which covers "no photo",
   * "no such identity", and "that id is not one an avatar could have".
   *
   * The content hash is computed from the file on the way out rather than
   * cached, so the ETag cannot drift from the bytes actually being served. It
   * costs one extra read of at most 2 MB from the local disk.
   *
   * @param id - The identity id.
   */
  async get(id: string): Promise<StoredAvatar | null> {
    if (!isSafeId(id)) return null;
    for (const [extension, contentType] of CONTENT_TYPE_BY_EXTENSION) {
      const file = this.fileFor(id, extension);
      const bytes = await readIfPresent(file);
      if (!bytes) continue;
      return { stream: createReadStream(file), contentType, etag: `"${hashOf(bytes)}"` };
    }
    return null;
  }

  /**
   * Remove this identity's photo in every format it could be stored as.
   *
   * @param id - The identity id.
   */
  async delete(id: string): Promise<void> {
    assertSafeId(id);
    await this.removeExcept(id, null);
  }

  /** Drop every stored format for `id` except `keep` (all of them when `null`). */
  private async removeExcept(id: string, keep: string | null): Promise<void> {
    for (const extension of CONTENT_TYPE_BY_EXTENSION.keys()) {
      if (extension === keep) continue;
      await rm(this.fileFor(id, extension), { force: true });
    }
  }

  /**
   * The path this id's photo lives at, refusing any id that could reach outside
   * the avatar directory.
   *
   * The containment check is the same shape `routes/uploads.ts` makes: refuse
   * the id by its characters, then prove the resolved path is still inside.
   */
  private fileFor(id: string, extension: string): string {
    assertSafeId(id);
    const file = path.resolve(this.dir, `${id}.${extension}`);
    if (path.dirname(file) !== path.resolve(this.dir)) throw new InvalidAvatarIdError(id);
    return file;
  }
}

/** Whether an id is one an avatar may be filed under. */
function isSafeId(id: string): boolean {
  return SAFE_ID.test(id) && id !== '.' && id !== '..';
}

/** Refuse an id that could be read as a path. */
function assertSafeId(id: string): void {
  if (!isSafeId(id)) throw new InvalidAvatarIdError(id);
}

/** The short content hash that versions a URL and fills an ETag. */
function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LENGTH);
}

/** The file's bytes, or `null` when it is not there. */
async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
