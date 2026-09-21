import { constants } from 'node:fs';
import { link, mkdir, open, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BlobRead, BlobStore, PutBlobInput, StoredBlob } from './blob-store.js';
import { assertNotAborted, BlobStoreError, stageBlob, validateBlobKey } from './blob-store.js';

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

  /** Open a stored object without following a key-named symlink. */
  async get(key: string, options: { signal?: AbortSignal } = {}): Promise<BlobRead> {
    validateBlobKey(key);
    assertNotAborted(options.signal);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(join(this.directory, key), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new BlobStoreError('BLOB_NOT_FOUND', 'Blob not found');
      assertNotAborted(options.signal);
      const body = handle.createReadStream({ autoClose: true, signal: options.signal });
      return { body, byteSize: stat.size };
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
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
