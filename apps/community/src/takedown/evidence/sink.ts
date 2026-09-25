import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CommunityConfig } from '../../config.js';

/** What a copy must hash to and how long it must be; a copy that differs is refused. */
export interface EvidenceExpectation {
  sha256: string;
  byteSize: number;
}

/** Bytes to write: a stream from primary storage, or the record in memory. */
export type EvidenceSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/**
 * The evidence store, from the server's side: it can add a file and nothing else. It never
 * reads, lists, replaces, or deletes, so the host can give the server write-only rights there.
 */
export interface EvidenceSink {
  /** Write `source` at `path`, once. Refuses a path that already holds a file. */
  put(path: string, source: EvidenceSource, expected: EvidenceExpectation): Promise<void>;
}

/** A named, content-free reason an evidence write failed. */
export class EvidenceSinkError extends Error {
  constructor(
    readonly code:
      | 'EVIDENCE_EXISTS'
      | 'EVIDENCE_CHECKSUM_MISMATCH'
      | 'EVIDENCE_INVALID_PATH'
      | 'EVIDENCE_WRITE_FAILED'
  ) {
    super(code);
    this.name = 'EvidenceSinkError';
  }
}

const EVIDENCE_PATH =
  /^takedowns\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/attempt-[1-9][0-9]{0,5}\/(?:files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|icon|record\.json)$/;

/** Only a path the server built itself can reach the store. */
function assertEvidencePath(path: string): void {
  if (!EVIDENCE_PATH.test(path)) throw new EvidenceSinkError('EVIDENCE_INVALID_PATH');
}

/** The folder one attempt writes into, relative to the store: `takedowns/<id>/attempt-<n>/`. */
export function evidenceAttemptFolder(takedownId: string, attempt: number): string {
  return `takedowns/${takedownId}/attempt-${attempt}/`;
}

/** A temporary name the filesystem sink writes before linking, and the only name it deletes. */
const TEMPORARY_NAME = /^\.tmp-[a-f0-9]{32}$/;
const TEMPORARY_MAX_AGE_MS = 60 * 60_000;

/**
 * Write `source` to a new private file at `path`, flushed to disk, and check its length and
 * SHA-256 against `expected`. The caller removes the file.
 */
async function stageVerified(
  path: string,
  source: EvidenceSource,
  expected: EvidenceExpectation
): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    const hash = createHash('sha256');
    let byteSize = 0;
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      byteSize += bytes.length;
      if (byteSize > expected.byteSize) throw new EvidenceSinkError('EVIDENCE_CHECKSUM_MISMATCH');
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await handle.write(bytes, offset, bytes.length - offset);
        offset += written.bytesWritten;
      }
    }
    await handle.sync();
    if (byteSize !== expected.byteSize || hash.digest('hex') !== expected.sha256)
      throw new EvidenceSinkError('EVIDENCE_CHECKSUM_MISMATCH');
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * An evidence store on a disk the host keeps apart from primary storage.
 *
 * Each file is written under a temporary name opened exclusively, flushed, and then hard-linked
 * to its final name. A link fails with `EEXIST` instead of replacing a file, where a rename would
 * silently overwrite one. The temporary name is then removed and the folder flushed.
 */
export class FileSystemEvidenceSink implements EvidenceSink {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async put(path: string, source: EvidenceSource, expected: EvidenceExpectation): Promise<void> {
    assertEvidencePath(path);
    const target = join(this.directory, ...path.split('/'));
    const folder = dirname(target);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(folder, `.tmp-${randomBytes(16).toString('hex')}`);
    try {
      await stageVerified(temporary, source, expected);
      try {
        await link(temporary, target);
      } catch (error) {
        if (hasCode(error, 'EEXIST')) throw new EvidenceSinkError('EVIDENCE_EXISTS');
        throw error;
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!hasCode(error, 'ENOENT')) throw error;
      });
    }
    await syncDirectory(folder);
  }

  /**
   * Remove this sink's own temporary files older than an hour, left by a write that stopped
   * midway. It never follows a link and never touches any other file.
   *
   * @returns How many temporary files it removed.
   */
  async sweepTemporaryFiles(now = Date.now()): Promise<number> {
    let removed = 0;
    const walk = async (folder: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch (error) {
        if (hasCode(error, 'ENOENT')) return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (depth < 4) await walk(path, depth + 1);
        } else if (entry.isFile() && TEMPORARY_NAME.test(entry.name)) {
          const stat = await lstat(path);
          if (stat.isFile() && now - stat.mtimeMs > TEMPORARY_MAX_AGE_MS) {
            await unlink(path);
            removed++;
          }
        }
      }
    };
    await walk(this.directory, 0);
    return removed;
  }
}

/** Settings for an S3-compatible evidence bucket; `client` replaces the SDK client in tests. */
export interface S3EvidenceSinkOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Written in front of every path, e.g. `community-a/`. */
  prefix?: string;
  client?: Pick<S3Client, 'send'>;
}

/**
 * An evidence store in an S3-compatible bucket. It sends only `PutObject`, with the file's
 * SHA-256 and `If-None-Match: *`, so the server needs only put rights. Not every S3-compatible
 * store honours `If-None-Match` on a put; object lock or a bucket policy that denies overwrites
 * is what actually prevents one (OPERATIONS.md). Each file is staged on local disk first, one at
 * a time, and removed after.
 */
export class S3EvidenceSink implements EvidenceSink {
  private readonly client: Pick<S3Client, 'send'>;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3EvidenceSinkOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ? `${options.prefix.replace(/\/+$/, '')}/` : '';
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        endpoint: options.endpoint,
        forcePathStyle: Boolean(options.endpoint),
        credentials:
          options.accessKeyId && options.secretAccessKey
            ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
            : undefined,
      });
  }

  async put(path: string, source: EvidenceSource, expected: EvidenceExpectation): Promise<void> {
    assertEvidencePath(path);
    const folder = await mkdtemp(join(tmpdir(), 'community-evidence-'));
    try {
      const staged = join(folder, 'object');
      await stageVerified(staged, source, expected);
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: `${this.prefix}${path}`,
            Body: createReadStream(staged),
            ContentLength: expected.byteSize,
            ChecksumSHA256: Buffer.from(expected.sha256, 'hex').toString('base64'),
            IfNoneMatch: '*',
          })
        );
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 412 || (error instanceof Error && error.name === 'PreconditionFailed'))
          throw new EvidenceSinkError('EVIDENCE_EXISTS');
        throw error;
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
}

/** The S3 sink's local staging folders: `mkdtemp` adds six characters to this prefix. */
const STAGING_FOLDER = /^community-evidence-[A-Za-z0-9]{6}$/;

/**
 * Remove the S3 evidence sink's own staging folders older than an hour, left in the temporary
 * folder by a write that stopped midway (a crash or a kill between staging and cleanup). It
 * never follows a link and never touches another folder.
 *
 * @returns How many folders it removed.
 */
export async function sweepEvidenceStagingFolders(
  now = Date.now(),
  directory = tmpdir()
): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !STAGING_FOLDER.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isDirectory() && now - stat.mtimeMs > TEMPORARY_MAX_AGE_MS) {
      await rm(path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * At startup, remove what a write that stopped midway left behind: the filesystem sink's old
 * temporary files (the only files the server ever deletes in the evidence folder), or the S3
 * sink's old staging folders. Tidying never stops startup: a leftover it cannot remove is logged.
 */
export async function tidyEvidenceSink(
  sink: EvidenceSink | null,
  options: { warn?: (message: string, detail: string) => void; stagingDirectory?: string } = {}
): Promise<void> {
  if (!sink) return;
  try {
    if (sink instanceof FileSystemEvidenceSink) await sink.sweepTemporaryFiles();
    else await sweepEvidenceStagingFolders(Date.now(), options.stagingDirectory);
  } catch (error) {
    (options.warn ?? ((message, detail) => console.warn(message, detail)))(
      'Community evidence cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  }
}

/** The configured evidence store, or null when the host set none. */
export function createEvidenceSink(
  evidence: CommunityConfig['evidence']
): FileSystemEvidenceSink | S3EvidenceSink | null {
  if (!evidence) return null;
  return evidence.kind === 'filesystem'
    ? new FileSystemEvidenceSink(evidence.directory)
    : new S3EvidenceSink(evidence);
}
