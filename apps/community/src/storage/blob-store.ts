import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

/** Server-owned key; no caller-controlled filename or path segment is accepted as a key. */
export type BlobKey = string;

/** Metadata persisted by the caller in Postgres after a successful put. */
export interface StoredBlob {
  key: BlobKey;
  displayName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
}

/** Input limits and identity for a streaming blob write. */
export interface PutBlobInput {
  source: AsyncIterable<Uint8Array>;
  displayName: string;
  maxBytes: number;
  kind?: 'attachment' | 'export';
  signal?: AbortSignal;
}

/** Streaming read response; the caller owns and must consume or destroy the body. */
export interface BlobRead {
  body: Readable;
  byteSize: number;
}

/** Storage errors with stable codes for API mapping. */
export class BlobStoreError extends Error {
  constructor(
    readonly code:
      | 'BLOB_ABORTED'
      | 'BLOB_EMPTY'
      | 'BLOB_INVALID_KEY'
      | 'BLOB_NOT_FOUND'
      | 'BLOB_TOO_LARGE'
      | 'BLOB_TYPE_REJECTED',
    message: string
  ) {
    super(message);
    this.name = 'BlobStoreError';
  }
}

/** Backend-neutral byte store. Authorization and metadata lifetime belong to Postgres callers. */
export interface BlobStore {
  put(input: PutBlobInput): Promise<StoredBlob>;
  get(key: BlobKey, options?: { signal?: AbortSignal }): Promise<BlobRead>;
  delete(key: BlobKey, options?: { signal?: AbortSignal }): Promise<void>;
}

/** Validate an opaque key before it reaches a filesystem path or object-store request. */
export function validateBlobKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new BlobStoreError('BLOB_INVALID_KEY', 'Invalid blob key');
  }
}

/** Reject an already cancelled operation before performing I/O. */
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled');
}

/** Display-only filename that cannot inject headers or become a path segment. */
export function sanitizeDisplayName(name: string): string {
  const clean = Array.from(name.normalize('NFKC'), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 ||
      code === 127 ||
      (code >= 0xd800 && code <= 0xdfff) ||
      character === '/' ||
      character === '\\'
      ? '_'
      : character;
  })
    .slice(0, 180)
    .join('')
    .replace(/^\.+/, '')
    .trim();
  return clean || 'download';
}

/** Safe response headers for a caller-authorized download. */
export function downloadHeaders(metadata: Pick<StoredBlob, 'displayName' | 'contentType'>) {
  const name = sanitizeDisplayName(metadata.displayName);
  const ascii = name.replace(/[^\x20-\x7e]|["\\;]/g, '_');
  const safeType = ALLOWED_CONTENT_TYPES.has(metadata.contentType)
    ? metadata.contentType
    : 'application/octet-stream';
  const encodedName = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return {
    'content-type': safeType,
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodedName}`,
    'x-content-type-options': 'nosniff',
  };
}

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain; charset=utf-8',
  'application/zip',
]);

function detectedType(sample: Buffer, textValid: boolean, kind: 'attachment' | 'export'): string {
  if (kind === 'export') {
    if (sample.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      return 'application/zip';
    }
    throw new BlobStoreError('BLOB_TYPE_REJECTED', 'Export must be a ZIP archive');
  }
  if (sample.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (sample.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (
    sample
      .subarray(0, 6)
      .toString('ascii')
      .match(/^GIF8[79]a$/)
  )
    return 'image/gif';
  if (
    sample.subarray(0, 4).toString('ascii') === 'RIFF' &&
    sample.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  if (sample.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (textValid) return 'text/plain; charset=utf-8';
  throw new BlobStoreError('BLOB_TYPE_REJECTED', 'File type is not allowed');
}

/** Stage a bounded source to a private temporary file and verify its bytes. */
export async function stageBlob(directory: string, input: PutBlobInput) {
  const ceiling = input.kind === 'export' ? 1024 * 1024 * 1024 : 25 * 1024 * 1024;
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > ceiling) {
    throw new BlobStoreError('BLOB_TOO_LARGE', 'Invalid blob size limit');
  }
  assertNotAborted(input.signal);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  const tempPath = join(directory, `.${key}.upload`);
  const handle = await open(tempPath, 'wx', 0o600);
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let textValid = true;
  let textPrefix: 'leading' | 'hash' | 'safe' = 'leading';
  const inspectText = (decoded: string) => {
    for (const character of decoded) {
      const code = character.codePointAt(0) ?? 0;
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
        textValid = false;
        return;
      }
      if (textPrefix === 'leading') {
        if (character.trim() === '') continue;
        if (character === '<') {
          textValid = false;
          return;
        }
        textPrefix = character === '#' ? 'hash' : 'safe';
      } else if (textPrefix === 'hash') {
        if (character === '!') {
          textValid = false;
          return;
        }
        textPrefix = 'safe';
      }
    }
  };
  let byteSize = 0;
  let sample = Buffer.alloc(0);
  let success = false;
  const iterator = input.source[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextChunk(iterator, input.source, input.signal);
      if (next.done) break;
      const raw = next.value;
      assertNotAborted(input.signal);
      if (raw.length > input.maxBytes - byteSize) {
        throw new BlobStoreError('BLOB_TOO_LARGE', 'Blob exceeds the configured byte limit');
      }
      const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      byteSize += bytes.length;
      for (let start = 0; start < bytes.length; start += 64 * 1024) {
        const chunk = bytes.subarray(start, start + 64 * 1024);
        hash.update(chunk);
        if (sample.length < 4096) {
          sample = Buffer.concat([sample, chunk.subarray(0, 4096 - sample.length)]);
        }
        if (textValid) {
          try {
            inspectText(decoder.decode(chunk, { stream: true }));
          } catch {
            textValid = false;
          }
        }
        let offset = 0;
        while (offset < chunk.length) {
          assertNotAborted(input.signal);
          const result = await handle.write(chunk, offset, chunk.length - offset);
          offset += result.bytesWritten;
        }
      }
    }
    assertNotAborted(input.signal);
    if (byteSize === 0) throw new BlobStoreError('BLOB_EMPTY', 'Blob is empty');
    if (textValid) {
      try {
        inspectText(decoder.decode());
      } catch {
        textValid = false;
      }
    }
    const contentType = detectedType(sample, textValid, input.kind ?? 'attachment');
    await handle.sync();
    success = true;
    return {
      tempPath,
      metadata: {
        key,
        displayName: sanitizeDisplayName(input.displayName),
        contentType,
        byteSize,
        sha256: hash.digest('hex'),
      } satisfies StoredBlob,
    };
  } catch (error) {
    try {
      if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
    } catch {
      // Preserve the original write or cancellation error.
    }
    if (input.signal?.aborted) throw new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled');
    throw error;
  } finally {
    await handle.close();
    if (!success) await rm(tempPath, { force: true });
  }
}

function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): Promise<IteratorResult<Uint8Array>> {
  if (!signal) return iterator.next();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      if (source instanceof Readable) source.destroy();
      reject(new BlobStoreError('BLOB_ABORTED', 'Blob operation cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        }
      );
  });
}
