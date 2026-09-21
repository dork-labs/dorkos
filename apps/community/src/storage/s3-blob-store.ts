import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { BlobRead, BlobStore, PutBlobInput, StoredBlob } from './blob-store.js';
import { assertNotAborted, BlobStoreError, stageBlob, validateBlobKey } from './blob-store.js';

/** Settings for a private S3-compatible bucket; credentials may come from the SDK chain. */
export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** S3-compatible implementation using bounded disk staging for known-length SDK uploads. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: Boolean(options.endpoint),
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined,
    });
  }

  /** Upload a verified object by key without buffering it in memory. */
  async put(input: PutBlobInput): Promise<StoredBlob> {
    const directory = await mkdtemp(join(tmpdir(), 'community-s3-'));
    let key: string | undefined;
    try {
      const staged = await stageBlob(directory, input);
      key = staged.metadata.key;
      assertNotAborted(input.signal);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: createReadStream(staged.tempPath),
          ContentLength: staged.metadata.byteSize,
          ContentType: staged.metadata.contentType,
          ChecksumSHA256: Buffer.from(staged.metadata.sha256, 'hex').toString('base64'),
        }),
        { abortSignal: input.signal }
      );
      return staged.metadata;
    } catch (error) {
      // A cancelled request can race a committed remote put. Reclaim it before surfacing failure.
      if (key) {
        await this.client
          .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
          .catch(() => {});
      }
      if (input.signal?.aborted)
        throw new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled');
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** Open an SDK response stream; callers must consume or destroy it to release the socket. */
  async get(key: string, options: { signal?: AbortSignal } = {}): Promise<BlobRead> {
    validateBlobKey(key);
    assertNotAborted(options.signal);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: options.signal }
      );
      if (!(result.Body instanceof Readable)) throw new Error('S3 returned no readable body');
      const body = result.Body;
      if (options.signal) {
        const abort = () =>
          body.destroy(new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled'));
        options.signal.addEventListener('abort', abort, { once: true });
        body.once('close', () => options.signal?.removeEventListener('abort', abort));
        if (options.signal.aborted) abort();
      }
      return { body, byteSize: result.ContentLength ?? 0 };
    } catch (error) {
      if (options.signal?.aborted)
        throw new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled');
      if (isMissing(error)) throw new BlobStoreError('BLOB_NOT_FOUND', 'Blob not found');
      throw error;
    }
  }

  /** Delete an object; S3 deletion is naturally idempotent. */
  async delete(key: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    validateBlobKey(key);
    assertNotAborted(options.signal);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted)
        throw new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled');
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && ['NoSuchKey', 'NotFound'].includes(error.name);
}
