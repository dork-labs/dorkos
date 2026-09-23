import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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

  /**
   * Open an SDK response stream, or an inclusive range of the object with a `Range` request whose
   * `Content-Range` answer must match it exactly. Callers must consume or destroy the stream to
   * release the socket.
   */
  async get(key: string, options: BlobGetOptions = {}): Promise<BlobRead> {
    validateBlobKey(key);
    const { range } = options;
    if (range) validateBlobRange(range);
    assertNotAborted(options.signal);
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
        { abortSignal: options.signal }
      );
      if (!(result.Body instanceof Readable)) throw new Error('S3 returned no readable body');
      const body = result.Body;
      if (range) {
        const expected = range.end - range.start + 1;
        const answered = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(result.ContentRange ?? '');
        if (
          !answered ||
          Number(answered[1]) !== range.start ||
          Number(answered[2]) !== range.end ||
          (result.ContentLength !== undefined && result.ContentLength !== expected)
        ) {
          // S3 shortens a range that runs past the end instead of refusing it.
          body.destroy();
          throw new BlobStoreError(
            'BLOB_RANGE_NOT_SATISFIABLE',
            'Range is past the end of the blob'
          );
        }
      }
      if (options.signal) {
        const abort = () =>
          body.destroy(new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled'));
        options.signal.addEventListener('abort', abort, { once: true });
        body.once('close', () => options.signal?.removeEventListener('abort', abort));
        if (options.signal.aborted) abort();
      }
      return {
        body,
        byteSize: range ? range.end - range.start + 1 : (result.ContentLength ?? 0),
      };
    } catch (error) {
      if (options.signal?.aborted)
        throw new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled');
      if (isMissing(error)) throw new BlobStoreError('BLOB_NOT_FOUND', 'Blob not found');
      if (isRangeNotSatisfiable(error)) {
        throw new BlobStoreError('BLOB_RANGE_NOT_SATISFIABLE', 'Range is past the end of the blob');
      }
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

  /** Exhaust every S3 page and return no snapshot when any page is incomplete or invalid. */
  async listNamespace(options: { signal?: AbortSignal } = {}) {
    const keys = new Set<string>();
    let unexpectedEntries = 0;
    let continuationToken: string | undefined;
    const seenTokens = new Set<string>();
    try {
      for (;;) {
        assertNotAborted(options.signal);
        const page = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: continuationToken }),
          { abortSignal: options.signal }
        );
        for (const item of page.Contents ?? []) {
          if (!item.Key || !/^[a-f0-9]{64}$/.test(item.Key)) {
            unexpectedEntries++;
          } else if (keys.has(item.Key)) {
            throw new Error('duplicate key');
          } else {
            keys.add(item.Key);
          }
        }
        if (!page.IsTruncated) break;
        const next = page.NextContinuationToken;
        if (!next || seenTokens.has(next)) throw new Error('invalid continuation');
        seenTokens.add(next);
        continuationToken = next;
      }
    } catch {
      if (options.signal?.aborted)
        throw new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled');
      throw new BlobStoreError('BLOB_LIST_INCOMPLETE', 'Blob namespace listing failed');
    }
    return { keys: [...keys].sort(), temporaryKeys: [], unexpectedEntries };
  }
}

function isRangeNotSatisfiable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return error.name === 'InvalidRange' || status === 416;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && ['NoSuchKey', 'NotFound'].includes(error.name);
}
