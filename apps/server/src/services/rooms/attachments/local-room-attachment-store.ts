/**
 * The only {@link RoomAttachmentStore} implementation today: a room's files on
 * this machine, under the DorkOS data directory.
 *
 * `<dorkHome>/rooms/<roomId>/attachments/<attachmentId>.<ext>`, where `dorkHome`
 * is the value `resolveDorkHome()` produced at startup and handed to the
 * constructor — **never the operating system's home directory**, which is
 * banned in `apps/server/src` outside three carve-outs (Hard Rule 3,
 * `.claude/rules/dork-home.md`), and never the upload directory either:
 * `UploadHandler.getUploadDir(cwd)` is `{cwd}/.dork/.temp/uploads`, which is
 * per-project and temporary. A room's files are per-install and durable,
 * exactly like a profile photo.
 *
 * @module server/services/rooms/attachments/local-room-attachment-store
 */
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import {
  InvalidRoomAttachmentIdError,
  type RoomAttachmentStore,
  type StoredRoomAttachment,
} from './room-attachment-store.js';

/**
 * The characters a room id or an attachment id may be made of.
 *
 * The same allowlist {@link LocalAvatarStore} uses, and an allowlist rather than
 * an escape for the same reason: both ids reach this module from a URL path
 * segment, and the only safe way to know a string is not a path is that it
 * cannot contain one. Room ids and attachment ids are both ULIDs, which live
 * comfortably inside this.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The characters a stored file's suffix may be made of.
 *
 * Untrusted for the same reason the ids are: it comes off a filename somebody
 * uploaded. Empty is allowed — a file with no suffix is stored under its bare
 * id, with no trailing dot.
 */
const SAFE_EXTENSION = /^[A-Za-z0-9]*$/;

/** A room's files on this machine's disk. */
export class LocalRoomAttachmentStore implements RoomAttachmentStore {
  private readonly root: string;

  /**
   * Bind the store to one install's data directory.
   *
   * @param dorkHome - The resolved DorkOS data directory. Required, with no
   *   fallback, per `.claude/rules/dork-home.md`.
   */
  constructor(dorkHome: string) {
    this.root = path.join(dorkHome, 'rooms');
  }

  /**
   * Write the bytes and answer the URL the cockpit fetches them from.
   *
   * The write lands via a uniquely-named temp file and a rename, so an
   * interrupted write never leaves a truncated file where a whole one was, and
   * two writers cannot stage over each other. There is no replace-across-formats
   * dance to serialize: an attachment id is minted per upload and written once.
   *
   * @param roomId - The room the file was uploaded into.
   * @param attachmentId - The freshly minted attachment id.
   * @param extension - The file suffix, without a dot. May be empty.
   * @param bytes - The file.
   */
  async put(
    roomId: string,
    attachmentId: string,
    extension: string,
    bytes: Buffer
  ): Promise<{ url: string }> {
    const file = this.fileFor(roomId, attachmentId, extension);
    await mkdir(path.dirname(file), { recursive: true });
    const staged = `${file}.${randomUUID()}.tmp`;
    await writeFile(staged, bytes);
    await rename(staged, file);
    return {
      url: `/api/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}`,
    };
  }

  /**
   * Open one back, or answer `null` — which covers "no such file", "no such
   * room", and "that id is not one an attachment could have".
   *
   * **The bytes are streamed, never buffered** — the validator comes from one
   * `stat`, so serving a 200 costs no extra read and answering a 304 costs no
   * read at all. Hashing the content here instead meant reading the whole file
   * into memory to decide whether to send it, which is the opposite of what a
   * conditional request is for and scaled with the size of every attachment
   * anyone had ever uploaded.
   *
   * `contentType` is whatever the row says: this store never decides what a file
   * is, because the only trustworthy answer to that was settled at upload.
   *
   * @param roomId - The room the file was uploaded into.
   * @param attachmentId - The attachment id.
   * @param extension - The file suffix the row recorded, without a dot.
   * @param contentType - What the row says it is.
   */
  async get(
    roomId: string,
    attachmentId: string,
    extension: string,
    contentType: string
  ): Promise<StoredRoomAttachment | null> {
    const file = this.safeFileOrNull(roomId, attachmentId, extension);
    if (!file) return null;
    const info = await statIfPresent(file);
    if (!info) return null;
    return {
      stream: createReadStream(file),
      contentType,
      etag: weakEtag(info.size, info.mtimeMs),
      size: info.size,
    };
  }

  /**
   * Where the file sits on this machine, or `null` when there is nothing there.
   *
   * A remote store answers `null` unconditionally, which is what tells the agent
   * projector to fetch the bytes rather than link them.
   *
   * @param roomId - The room the file was uploaded into.
   * @param attachmentId - The attachment id.
   * @param extension - The file suffix the row recorded, without a dot.
   */
  async localPath(roomId: string, attachmentId: string, extension: string): Promise<string | null> {
    const file = this.safeFileOrNull(roomId, attachmentId, extension);
    if (!file) return null;
    // `stat`, not a read: the caller wants a path to link or copy, and reading
    // the bytes to prove they exist would defeat the point of answering a path.
    try {
      await stat(file);
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Drop one file. Idempotent — `force` is what makes deleting one that is
   * already gone a success.
   *
   * An unusable id is nothing to delete rather than an error, the same
   * asymmetry {@link LocalRoomAttachmentStore.get} draws: the caller's intent
   * (that file is not here any more) is satisfied either way.
   *
   * @param roomId - The room the file was uploaded into.
   * @param attachmentId - The attachment id.
   * @param extension - The file suffix the row recorded, without a dot.
   */
  async delete(roomId: string, attachmentId: string, extension: string): Promise<void> {
    const file = this.safeFileOrNull(roomId, attachmentId, extension);
    if (!file) return;
    await rm(file, { force: true });
  }

  /** Where one room's files live, refusing a room id that could be a path. */
  private dirFor(roomId: string): string {
    assertSafeId(roomId);
    const dir = path.resolve(this.root, roomId, 'attachments');
    if (path.dirname(path.dirname(dir)) !== path.resolve(this.root)) {
      throw new InvalidRoomAttachmentIdError(roomId);
    }
    return dir;
  }

  /**
   * The path this attachment lives at, refusing anything that could reach
   * outside its room's directory.
   *
   * The same double guard `LocalAvatarStore.fileFor` makes: refuse the id by its
   * characters, then prove the resolved path is still inside.
   */
  private fileFor(roomId: string, attachmentId: string, extension: string): string {
    const dir = this.dirFor(roomId);
    assertSafeId(attachmentId);
    if (!SAFE_EXTENSION.test(extension)) throw new InvalidRoomAttachmentIdError(extension);
    const file = path.resolve(dir, extension ? `${attachmentId}.${extension}` : attachmentId);
    if (path.dirname(file) !== dir) throw new InvalidRoomAttachmentIdError(attachmentId);
    return file;
  }

  /**
   * {@link LocalRoomAttachmentStore.fileFor} for the read paths, where an
   * unusable id is simply nothing to read rather than an error — the same
   * asymmetry `LocalAvatarStore` draws between `get` and `put`.
   */
  private safeFileOrNull(roomId: string, attachmentId: string, extension: string): string | null {
    if (!SAFE_ID.test(roomId) || !SAFE_ID.test(attachmentId) || !SAFE_EXTENSION.test(extension)) {
      return null;
    }
    return this.fileFor(roomId, attachmentId, extension);
  }
}

/** Refuse an id that could be read as a path. */
function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new InvalidRoomAttachmentIdError(id);
}

/**
 * The validator a conditional request compares against: size and mtime, weak.
 *
 * **Weak (`W/`) because it is honest.** A strong ETag promises byte equality,
 * and size-plus-mtime cannot: two different files could in principle share
 * both. What it can promise is that this exact stored file has not been
 * replaced, which is all a validator has to do — and here it is stronger in
 * practice than the label suggests, because an attachment is written once under
 * a freshly minted ULID and never rewritten.
 *
 * Hex to keep the header short.
 */
function weakEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
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
