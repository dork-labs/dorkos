import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  BlobGetOptions,
  BlobRead,
  BlobStore,
  PutBlobInput,
  StoredBlob,
} from './blob-store.js';
import {
  assertNotAborted,
  BlobStoreError,
  stageBlob,
  validateBlobKey,
  validateBlobRange,
} from './blob-store.js';

/** Persistent-volume implementation; files are addressed only by server-generated keys. */
export class FileSystemBlobStore implements BlobStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  /** Stage and validate bytes before atomically publishing a blob. */
  async put(input: PutBlobInput): Promise<StoredBlob> {
    const staged = await stageBlob(this.directory, input);
    try {
      assertNotAborted(input.signal);
      await link(staged.tempPath, join(this.directory, staged.metadata.key));
      return staged.metadata;
    } finally {
      await rm(staged.tempPath, { force: true });
    }
  }

  /** Open a stored object, or an inclusive range of it, without following a key-named symlink. */
  async get(key: string, options: BlobGetOptions = {}): Promise<BlobRead> {
    validateBlobKey(key);
    const { range } = options;
    if (range) validateBlobRange(range);
    assertNotAborted(options.signal);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(join(this.directory, key), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new BlobStoreError('BLOB_NOT_FOUND', 'Blob not found');
      assertNotAborted(options.signal);
      if (range && range.end >= stat.size) {
        throw new BlobStoreError('BLOB_RANGE_NOT_SATISFIABLE', 'Range is past the end of the blob');
      }
      const body = handle.createReadStream({
        autoClose: true,
        signal: options.signal,
        ...(range ? { start: range.start, end: range.end } : {}),
      });
      return { body, byteSize: range ? range.end - range.start + 1 : stat.size };
    } catch (error) {
      await handle?.close();
      if (options.signal?.aborted)
        throw new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled');
      if (isMissing(error)) throw new BlobStoreError('BLOB_NOT_FOUND', 'Blob not found');
      throw error;
    }
  }

  /** Delete an object; repeated deletion is safe for orphan reclamation. */
  async delete(key: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    validateBlobKey(key);
    assertNotAborted(options.signal);
    try {
      await unlink(join(this.directory, key));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  /** Enumerate the complete local namespace without following directory entries. */
  async listNamespace(options: { signal?: AbortSignal } = {}) {
    assertNotAborted(options.signal);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch {
      throw new BlobStoreError('BLOB_LIST_INCOMPLETE', 'Blob namespace listing failed');
    }
    const keys: string[] = [];
    const temporaryKeys: string[] = [];
    let unexpectedEntries = 0;
    for (const entry of entries) {
      assertNotAborted(options.signal);
      if (entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name)) {
        keys.push(entry.name);
      } else {
        const temporary = /^\.([a-f0-9]{64})\.upload$/.exec(entry.name);
        if (entry.isFile() && temporary) temporaryKeys.push(temporary[1]);
        else unexpectedEntries++;
      }
    }
    keys.sort();
    temporaryKeys.sort();
    return { keys, temporaryKeys, unexpectedEntries };
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
