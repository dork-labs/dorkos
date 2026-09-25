import { createHash } from 'node:crypto';
import { mkdtemp, open, readdir, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { ApiError } from '../http.js';
import { IMPORT_TEMP_PREFIXES, IMPORT_UPLOAD_LEASE_MS } from './store.js';

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** The refusal an upload gets for bytes that do not match what it declared. */
export const archiveInvalid = (message: string) =>
  new ApiError(400, 'IMPORT_ARCHIVE_INVALID', message);

/** A received upload on local disk, verified against its declared size and digest. */
export interface ReceivedArchive {
  directory: string;
  path: string;
}

/**
 * Receive the request body into a private temporary file, refusing it the moment it runs past
 * its declared size or goes `idleMs` without a byte, and check its length, digest, and zip
 * signature before anything is reserved in storage.
 *
 * Streaming straight into a storage reservation would leave a writer whose outcome storage
 * cannot vouch for whenever the connection breaks, and the blob inventory keeps such a
 * reservation as a permanent cleanup tombstone that holds the import's community forever. A
 * body that breaks off or does not match here leaves nothing behind, so the upload token
 * stays usable for another try.
 */
export async function receiveArchive(
  body: ReadableStream<Uint8Array>,
  declared: { bytes: number; sha256: string },
  options: { signal: AbortSignal; idleMs: number; onProgress: () => Promise<void> }
): Promise<ReceivedArchive> {
  const directory = await mkdtemp(join(tmpdir(), IMPORT_TEMP_PREFIXES[0]));
  const path = join(directory, 'archive.zip');
  let kept = false;
  try {
    const file = await open(path, 'wx', 0o600);
    const hash = createHash('sha256');
    let received = 0;
    let head = Buffer.alloc(0);
    const reader = body.getReader();
    try {
      while (true) {
        if (options.signal.aborted) throw archiveInvalid('The upload was interrupted.');
        let idle: ReturnType<typeof setTimeout> | undefined;
        let item: ReadableStreamReadResult<Uint8Array>;
        try {
          item = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              idle = setTimeout(() => reject(new Error('idle')), options.idleMs);
            }),
          ]);
        } catch {
          await reader.cancel().catch(() => undefined);
          throw archiveInvalid('The upload was interrupted.');
        } finally {
          clearTimeout(idle);
        }
        if (item.done) break;
        const chunk = item.value;
        received += chunk.byteLength;
        if (received > declared.bytes) {
          await reader.cancel().catch(() => undefined);
          throw archiveInvalid('The export is longer than its declared size.');
        }
        if (head.length < ZIP_LOCAL_HEADER.length)
          head = Buffer.concat([head, chunk.subarray(0, ZIP_LOCAL_HEADER.length - head.length)]);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await file.write(chunk, offset, chunk.byteLength - offset);
          offset += result.bytesWritten;
        }
        await options.onProgress();
      }
    } finally {
      reader.releaseLock();
      await file.close();
    }
    if (received !== declared.bytes)
      throw archiveInvalid('The export is shorter than its declared size.');
    if (hash.digest('hex') !== declared.sha256)
      throw archiveInvalid('The export does not match its declared SHA-256.');
    if (!head.equals(ZIP_LOCAL_HEADER)) throw archiveInvalid('The file is not a zip archive.');
    kept = true;
    return { directory, path };
  } finally {
    if (!kept) await rm(directory, { recursive: true, force: true });
  }
}

/**
 * How many uploads this replica receives at once. Each can hold up to twice its size of
 * temporary disk (the received copy, then storage's own staging copy), so the count bounds
 * what imports can take from the disk.
 */
export class UploadSlots {
  private used = 0;
  private reserved = 0;

  constructor(private readonly limit: number) {}

  /** Temporary bytes the uploads now in flight may still need. */
  get reservedBytes(): number {
    return this.reserved;
  }

  /**
   * Take a slot for an upload of `bytes`, reserving twice that much temporary space, or refuse
   * with `429` before the body is read.
   */
  take(bytes: number): () => void {
    if (this.used >= this.limit)
      throw new ApiError(429, 'RATE_LIMITED', 'Too many exports are uploading. Try again soon.');
    this.used++;
    this.reserved += bytes * 2;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      this.reserved -= bytes * 2;
    };
  }
}

/**
 * Refuse an upload the temporary folder has no room for: it needs twice its size, beyond what
 * the other uploads in flight (`othersReserved`) may still write.
 */
export async function assertTempSpace(
  bytes: number,
  free: () => Promise<number> = freeTempBytes,
  othersReserved = 0
): Promise<void> {
  if ((await free()) - othersReserved < bytes * 2)
    throw new ApiError(503, 'UNAVAILABLE', 'This server has no room for that export right now.');
}

async function freeTempBytes(): Promise<number> {
  const stats = await statfs(tmpdir());
  return stats.bavail * stats.bsize;
}

/**
 * Take the import's upload lease, so only one upload of it is received at a time on any
 * replica. A second upload is refused with `409` before its body is read. The lease is short
 * and renewed while bytes arrive, so a request that died frees it within minutes.
 */
export async function acquireUploadLease(pool: Pool, importId: string): Promise<string> {
  const leased = await pool.query<{ upload_lease_token: string }>(
    `UPDATE community_imports
     SET upload_lease_token=gen_random_uuid(),
       upload_lease_until=now() + ($2 * interval '1 millisecond')
     WHERE id=$1 AND state='awaiting_upload'
       AND (upload_lease_until IS NULL OR upload_lease_until<now())
     RETURNING upload_lease_token`,
    [importId, IMPORT_UPLOAD_LEASE_MS]
  );
  if (!leased.rows[0])
    throw new ApiError(409, 'STATE_CONFLICT', 'This export is already being uploaded.');
  return leased.rows[0].upload_lease_token;
}

/** Extend an upload lease this request holds; false when it no longer holds it. */
export async function renewUploadLease(
  pool: Pool,
  importId: string,
  token: string
): Promise<boolean> {
  const renewed = await pool.query(
    `UPDATE community_imports
     SET upload_lease_until=now() + ($3 * interval '1 millisecond')
     WHERE id=$1 AND upload_lease_token=$2`,
    [importId, token, IMPORT_UPLOAD_LEASE_MS]
  );
  return renewed.rowCount === 1;
}

/** The refusal an upload gets when its lease was lost to another upload of the same import. */
export const leaseLost = () =>
  new ApiError(409, 'STATE_CONFLICT', 'This export is already being uploaded.');

/** Give an upload lease back, if this request still holds it. */
export async function releaseUploadLease(pool: Pool, importId: string, token: string) {
  await pool.query(
    `UPDATE community_imports SET upload_lease_token=NULL,upload_lease_until=NULL
     WHERE id=$1 AND upload_lease_token=$2`,
    [importId, token]
  );
}

/**
 * Remove temporary import folders a crashed process left behind: those whose newest file has
 * not changed for `maxIdleMs`. A folder still being written is always newer than that.
 */
export async function sweepImportTempDirs(
  maxIdleMs: number,
  directory = tmpdir(),
  now = Date.now()
): Promise<number> {
  let removed = 0;
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!IMPORT_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const folder = join(directory, name);
    try {
      let newest = (await stat(folder)).mtimeMs;
      for (const child of await readdir(folder))
        newest = Math.max(newest, (await stat(join(folder, child))).mtimeMs);
      if (now - newest < maxIdleMs) continue;
      await rm(folder, { recursive: true, force: true });
      removed++;
    } catch {
      // Another process removed it first, or it is not ours to read; leave it.
    }
  }
  return removed;
}
