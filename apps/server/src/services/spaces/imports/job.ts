import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { SegmentedBlobSource, type RangeReader } from '../archive/segmented-source.js';
import { transaction } from '../data.js';
import { recordHostAudit } from '../host/authority.js';
import { readLimits } from '../host/limits.js';
import {
  BlobStoreError,
  discardManagedBlob,
  managedBlobWriteSignal,
  queueCommittedBlobDeletion,
  reserveImportBlob,
  settleImportBlob,
  type BlobStore,
  type StoredBlob,
} from '../storage/index.js';
import { ImportFailure } from './manifest.js';
import { IMPORT_LEASE_MS, IMPORT_TEMP_PREFIXES, loadImport, type ImportRow } from './store.js';

/** An import this worker holds the lease for. */
export interface ClaimedImport {
  id: string;
  state: 'validating' | 'restoring';
  lease: string;
}

/** The import's community is no longer one it may write into; the import is cancelled. */
export class ImportAbandoned extends Error {
  constructor() {
    super('The import can no longer finish');
    this.name = 'ImportAbandoned';
  }
}

/** The job's lease was taken by a cancel or another worker; stop without writing. */
export class LeaseLost extends Error {
  constructor() {
    super('The import lease was lost');
    this.name = 'LeaseLost';
  }
}

/** When the export arrived; nothing in it may claim to be newer. */
export function receivedAt(row: ImportRow): Date {
  if (!row.archive_received_at) throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
  return row.archive_received_at;
}

/**
 * Run `work` in a transaction that holds the import row and proves this worker still owns it:
 * the same lease, in the same state. A cancel clears the lease, so a cancelled import's worker
 * stops at its next write. Each fenced write also extends the lease.
 */
export async function fenced<T>(
  pool: Pool,
  job: ClaimedImport,
  work: (client: PoolClient, row: ImportRow) => Promise<T>,
  /** Lock this community first, in the order host routes lock a community and its import. */
  communityId?: string
): Promise<T> {
  return transaction(pool, async (client) => {
    if (communityId)
      await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId]);
    const row = await loadImport(client, job.id, 'FOR UPDATE');
    if (!row || row.lease_token !== job.lease || row.state !== job.state) throw new LeaseLost();
    await client.query(
      `UPDATE community_imports
       SET next_attempt_at=now() + ($2 * interval '1 millisecond'),updated_at=now() WHERE id=$1`,
      [job.id, IMPORT_LEASE_MS]
    );
    return work(client, row);
  });
}

/** Keep the lease through a long check, and stop at once if a cancel took it. */
export async function renewLease(pool: Pool, job: ClaimedImport): Promise<void> {
  const renewed = await pool.query(
    `UPDATE community_imports
     SET next_attempt_at=now() + ($3 * interval '1 millisecond'),updated_at=now()
     WHERE id=$1 AND lease_token=$2 AND state=$4`,
    [job.id, job.lease, IMPORT_LEASE_MS, job.state]
  );
  if (!renewed.rowCount) throw new LeaseLost();
}

/**
 * The uploaded export as one byte range: the single upload's staging blob, or every part in
 * part-number order. A part list that is not exactly 1 to n, or does not add up to the size the
 * import recorded, means the upload was tampered with after it completed.
 */
export async function importSource(
  db: Pick<Pool, 'query'>,
  blobStore: BlobStore,
  row: ImportRow
): Promise<RangeReader> {
  if (row.archive_bytes === null) throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
  const archiveBytes = Number(row.archive_bytes);
  if (row.upload_kind === 'parts') {
    const parts = await db.query<{ part_number: number; blob_key: string; byte_size: string }>(
      `SELECT part_number,blob_key,byte_size::text FROM community_import_parts
       WHERE import_id=$1 ORDER BY part_number`,
      [row.id]
    );
    const blobs = parts.rows.map((part, index) => {
      if (part.part_number !== index + 1) throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
      return { key: part.blob_key, byteSize: Number(part.byte_size) };
    });
    const source = new SegmentedBlobSource(blobStore, blobs);
    if (!blobs.length || source.size !== archiveBytes)
      throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
    return source;
  }
  if (!row.staging_blob_key) throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
  return new SegmentedBlobSource(blobStore, [
    { key: row.staging_blob_key, byteSize: archiveBytes },
  ]);
}

/** Copy verified bytes to a private temporary file; the caller removes `directory`. */
async function stageBytes(
  bytes: AsyncIterable<Uint8Array>
): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), IMPORT_TEMP_PREFIXES[1]));
  const path = join(directory, 'file');
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      for await (const chunk of bytes) {
        let offset = 0;
        while (offset < chunk.length) {
          offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
        }
      }
    } finally {
      await file.close();
    }
    return { directory, path };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** One file an import restores: where its verified bytes come from and what they must be. */
export interface RestoringFile {
  /** The export's id for it; the community icon uses the nil UUID. */
  sourceId: string;
  purpose: 'attachment' | 'icon';
  displayName: string;
  byteSize: number;
  checksum: string;
  /** The verified bytes; they throw if they do not match `byteSize` and `checksum`. */
  bytes: () => AsyncIterable<Uint8Array>;
}

/**
 * Store one restored file: verify and stage it locally, store it under a fresh reservation,
 * and record it in `community_import_files` in a fenced transaction, still `stored`. The
 * import's final transaction commits it with the rows; a restarted worker skips it.
 */
export async function storeRestoredFile(
  pool: Pool,
  blobStore: BlobStore,
  job: ClaimedImport,
  file: RestoringFile
): Promise<void> {
  const staged = await stageBytes(file.bytes());
  try {
    const reservation = await transaction(pool, (client) =>
      reserveImportBlob(client, job.id, file.purpose, 'restoring')
    );
    let blob: StoredBlob;
    try {
      blob = await blobStore.put({
        key: reservation.key,
        source: createReadStream(staged.path),
        displayName: file.displayName,
        maxBytes: file.byteSize,
        kind: file.purpose,
        signal: managedBlobWriteSignal(),
      });
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation).catch(() => undefined);
      // The bytes were verified; storage refusing their type means the export lied about them.
      if (error instanceof BlobStoreError && error.code === 'BLOB_TYPE_REJECTED')
        throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
      throw error;
    }
    try {
      if (blob.byteSize !== file.byteSize || blob.sha256 !== file.checksum)
        throw new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
      await fenced(pool, job, async (client) => {
        await settleImportBlob(client, reservation, blob, 'stored');
        await client.query(
          `INSERT INTO community_import_files(import_id,source_attachment_id,blob_key,content_type,purpose)
           VALUES($1,$2,$3,$4,$5)`,
          [job.id, file.sourceId, blob.key, blob.contentType, file.purpose]
        );
      });
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation, blob).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(staged.directory, { recursive: true, force: true });
  }
}

/** The files an import has stored so far, by source id: new key and detected type. */
export async function restoredFiles(
  client: PoolClient,
  importId: string
): Promise<Map<string, { blobKey: string; contentType: string }>> {
  const recorded = await client.query<{
    source_attachment_id: string;
    blob_key: string;
    content_type: string;
  }>(
    `SELECT source_attachment_id,blob_key,content_type FROM community_import_files
     WHERE import_id=$1 AND purpose='attachment'`,
    [importId]
  );
  return new Map(
    recorded.rows.map((file) => [
      file.source_attachment_id,
      { blobKey: file.blob_key, contentType: file.content_type },
    ])
  );
}

/**
 * The import's final transaction: commit every stored file, recheck the storage limit (it may
 * have been lowered since the export was checked), let `work` write what is left of the rows,
 * then mark the community imported and the import `ready`, and queue the uploaded export (the
 * staging blob or every part) for deletion. Until this commits nothing of the import is
 * visible; the community stays unclaimed with no member who can read it.
 *
 * @param expectedFiles - How many files (attachments, and the icon) the import stored.
 * @param work - Writes the remaining rows and returns the adopted owner's new member ID.
 */
export async function finishRestore(
  pool: Pool,
  job: ClaimedImport,
  communityId: string,
  expectedFiles: number,
  work: (client: PoolClient) => Promise<string>
): Promise<void> {
  await fenced(
    pool,
    job,
    async (client, current) => {
      const community = await client.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM communities WHERE id=$1',
        [communityId]
      );
      // Nothing but a claim moves an unclaimed community on, and a claim needs a ready import;
      // if it moved anyway, this import can never finish, so it ends instead of retrying.
      if (community.rows[0]?.lifecycle !== 'pending_owner') throw new ImportAbandoned();
      const recorded = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM community_import_files WHERE import_id=$1',
        [job.id]
      );
      const committed = await client.query(
        `UPDATE managed_blobs SET state='committed',committed_at=now()
         WHERE community_id=$1 AND state='stored'
           AND blob_key IN (SELECT blob_key FROM community_import_files WHERE import_id=$2)`,
        [communityId, job.id]
      );
      if (committed.rowCount !== expectedFiles || recorded.rows[0].n !== expectedFiles)
        throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
      const { maxStorageBytes } = await readLimits(client, communityId);
      if (maxStorageBytes !== null) {
        const counted = await client.query<{ bytes: string }>(
          `SELECT COALESCE(sum(byte_size),0)::text AS bytes FROM managed_blobs
           WHERE community_id=$1 AND purpose IN ('attachment','icon')
             AND state IN ('stored','committed')`,
          [communityId]
        );
        if (Number(counted.rows[0].bytes) > maxStorageBytes)
          throw new ImportFailure('STORAGE_LIMIT_REACHED');
      }
      const ownerId = await work(client);
      await client.query('UPDATE communities SET imported_at=now() WHERE id=$1', [communityId]);
      await client.query(
        `INSERT INTO audit_events(community_id,actor_kind,action,changed_fields)
         VALUES($1,'system','community.import',ARRAY['history'])`,
        [communityId]
      );
      await client.query('DELETE FROM community_import_files WHERE import_id=$1', [job.id]);
      await client.query(
        `UPDATE community_imports
         SET state='ready',staging_blob_key=NULL,adopt_member_id=$2,settled_at=now(),
           lease_token=NULL,restore_progress=NULL,updated_at=now()
         WHERE id=$1`,
        [job.id, ownerId]
      );
      if (current.staging_blob_key)
        await queueCommittedBlobDeletion(client, communityId, current.staging_blob_key);
      await queuePartDeletions(client, job.id, communityId);
      await recordHostAudit(
        client,
        { kind: 'system' },
        {
          action: 'import.complete',
          communityId,
          priorState: 'restoring',
          nextState: 'ready',
          changedFields: ['history'],
        }
      );
    },
    communityId
  );
}

/**
 * Forget every uploaded part of an import and queue its bytes for deletion, in the caller's
 * transaction. Returns how many parts there were.
 */
export async function queuePartDeletions(
  client: PoolClient,
  importId: string,
  communityId: string
): Promise<number> {
  const result = await client.query(
    `WITH parts AS (
       DELETE FROM community_import_parts WHERE import_id=$1 RETURNING blob_key
     ), queued AS (
       UPDATE managed_blobs SET state='pending_delete'
       WHERE community_id=$2 AND state='committed' AND blob_key IN (SELECT blob_key FROM parts)
       RETURNING blob_key
     )
     INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at)
     SELECT blob_key,0,now() FROM queued ON CONFLICT(blob_key) DO NOTHING`,
    [importId, communityId]
  );
  return result.rowCount ?? 0;
}
