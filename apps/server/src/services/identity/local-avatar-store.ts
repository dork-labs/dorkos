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
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { logError, logger } from '../../lib/logger.js';
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
   * The tail of the in-flight mutation chain for each id, while one is running.
   *
   * Keyed by id rather than global: two people replacing their own photos have
   * nothing to serialize, and one slow write should not queue behind another
   * identity's. Entries are dropped as soon as they are the tail and settle, so
   * this holds only ids being written to right now.
   */
  private readonly mutations = new Map<string, Promise<unknown>>();

  /**
   * Bind the store to one install's data directory.
   *
   * @param dorkHome - The resolved DorkOS data directory. Required, with no
   *   fallback, per `.claude/rules/dork-home.md`.
   */
  constructor(dorkHome: string) {
    this.dir = path.join(dorkHome, 'avatars');
    // `.catch(() => {})`, not just fire-and-forget: `sweepOrphanedTempFiles`
    // already logs and swallows every failure it recognizes, but a `void`ed
    // async call is one throw-from-somewhere-unexpected away from an unhandled
    // rejection, which crashes the process by default. A constructor doing that
    // to the caller would be a worse bug than any orphaned `.tmp` file.
    void this.sweepOrphanedTempFiles().catch(() => {});
  }

  /**
   * Remove staging files an interrupted {@link put} left behind.
   *
   * A crash between `writeFile` and `rename` in `put()` leaves
   * `<id>.<ext>.<uuid>.tmp` in the avatars directory forever — {@link
   * removeExcept} only ever looks at the three real extensions, so it never
   * reaps them. This runs once, best-effort, at construction time: a missing
   * directory (nothing uploaded yet) is not an error, and any other failure is
   * logged rather than thrown, since a sweep that could crash the store would
   * be worse than the orphans it is cleaning up.
   *
   * Only reaps a `.tmp` file older than {@link ORPHAN_TMP_AGE_MS}. `put()`'s own
   * staging window is milliseconds, so a file that young is somebody's write in
   * flight, not a crash's leftovers — skipping it is what keeps a second store
   * instance (a test; in principle a second process) from deleting the very
   * file a concurrent `put()` is about to `rename` into place.
   */
  private async sweepOrphanedTempFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger.error('[LocalAvatarStore] orphan sweep could not list avatars dir', logError(err));
      return;
    }
    await Promise.all(
      entries
        .filter((name) => name.endsWith('.tmp'))
        .map((name) => this.reapIfStale(path.join(this.dir, name)))
    );
  }

  /** Remove one `.tmp` file, but only once it is old enough to be an orphan. */
  private async reapIfStale(file: string): Promise<void> {
    try {
      const { mtimeMs } = await stat(file);
      if (Date.now() - mtimeMs < ORPHAN_TMP_AGE_MS) return;
    } catch (err) {
      // Gone already (another sweep, or the write it belonged to finished and
      // cleaned up after itself) — nothing left to reap.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger.error('[LocalAvatarStore] orphan sweep could not stat a .tmp file', logError(err));
      return;
    }
    await rm(file, { force: true }).catch((err: unknown) => {
      logger.error('[LocalAvatarStore] orphan sweep could not remove a .tmp file', logError(err));
    });
  }

  /**
   * Run a write for one id after every write already queued for that id.
   *
   * Two uploads for the same person interleaving is not hypothetical — a double
   * click sends two — and a bare `Promise.all` of two `put`s could rename one
   * format in while the other's cleanup was still running, leaving two files or,
   * worse, none. Serializing per id makes the "exactly one photo" invariant the
   * TSDoc claims actually true rather than merely likely.
   *
   * Reads are deliberately NOT queued behind this: they are safe against either
   * committed state, and blocking a `GET` behind an upload would make a page
   * wait on somebody else's write.
   *
   * @param id - The identity whose files this write touches.
   * @param work - The write itself.
   */
  private mutate<T>(id: string, work: () => Promise<T>): Promise<T> {
    // `.then(work, work)` rather than `.then(work)`: a failed write must not
    // strand every write queued behind it.
    const result = (this.mutations.get(id) ?? Promise.resolve()).then(work, work);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.mutations.set(id, settled);
    void settled.then(() => {
      if (this.mutations.get(id) === settled) this.mutations.delete(id);
    });
    return result;
  }

  /**
   * Write the photo, replacing whatever this identity had — including a photo
   * stored in a different format, whose file this removes rather than leaving
   * beside the new one.
   *
   * The write lands via a uniquely-named temp file and a rename, so a reader
   * never sees a half-written photo and two uploads cannot stage over each
   * other. **The new photo is committed BEFORE the old format is dropped**, so
   * an interruption leaves the person with a photo rather than with none — the
   * opposite order destroyed the only copy before the replacement existed. It is
   * safe because the old file is never what a reader falls back to:
   * {@link LocalAvatarStore.get} walks {@link CONTENT_TYPE_BY_EXTENSION} in Map
   * insertion order, which is fixed, so a moment where both files exist resolves
   * deterministically rather than by whatever the directory happens to list
   * first.
   *
   * Overlapping writes for one id are serialized ({@link LocalAvatarStore.mutate}),
   * so that moment is the only window in which two files coexist, and it closes
   * before the next write starts.
   *
   * @param id - The identity id.
   * @param bytes - The validated image.
   * @param contentType - What the bytes were sniffed to be.
   */
  async put(id: string, bytes: Buffer, contentType: AvatarContentType): Promise<{ url: string }> {
    const extension = EXTENSIONS[contentType];
    const file = this.fileFor(id, extension);
    return this.mutate(id, async () => {
      await mkdir(this.dir, { recursive: true });
      const staged = `${file}.${randomUUID()}.tmp`;
      await writeFile(staged, bytes);
      await rename(staged, file);
      await this.removeExcept(id, extension);
      return { url: `/api/profile/avatar/${encodeURIComponent(id)}?v=${hashOf(bytes)}` };
    });
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
   * Serialized against writes for the same id, so a delete racing an upload
   * cannot land between that upload's rename and its cleanup.
   *
   * @param id - The identity id.
   */
  async delete(id: string): Promise<void> {
    assertSafeId(id);
    await this.mutate(id, () => this.removeExcept(id, null));
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

/**
 * Whether an id is one an avatar may be filed under.
 *
 * `.` and `..` need no special case: {@link SAFE_ID} requires the first
 * character to be alphanumeric, so both are already refused — and the
 * `local-avatar-store` tests pin them either way.
 */
function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

/** Refuse an id that could be read as a path. */
function assertSafeId(id: string): void {
  if (!isSafeId(id)) throw new InvalidAvatarIdError(id);
}

/**
 * How old a `.tmp` staging file must be before the sweep will touch it.
 *
 * `put()`'s window between `writeFile` and `rename` is milliseconds — never
 * remotely close to this — so a second {@link LocalAvatarStore} constructed
 * over the same directory (a test creating one mid-upload; in principle a
 * second process) can run its own sweep concurrently without racing a write
 * that is actually still in flight. Anything this old was abandoned by a
 * crash, not delayed by load.
 */
const ORPHAN_TMP_AGE_MS = 60 * 60 * 1000;

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
