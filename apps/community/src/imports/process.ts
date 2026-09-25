import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
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
import { isRetryableProviderError } from '../storage/blob-store.js';
import { cleanupBackoffSql } from '../storage/pending-deletions.js';
import { openExport, verifiedFile, type OpenedExport } from './archive.js';
import { checkManifest, ImportFailure, type ImportLimits } from './manifest.js';
import { insertImportedRows, type RestoredFile } from './restore.js';
import {
  IMPORT_LEASE_MS,
  loadImport,
  type ImportFailureCode,
  type ImportReport,
  type ImportRow,
} from './store.js';

/** Storage failures an import retries before it fails as `IMPORT_STORAGE_UNAVAILABLE`. */
export const IMPORT_MAX_ATTEMPTS = 8;

/** Test seams: pause or stop the worker at the two points a crash matters most. */
export interface ImportWorkerHooks {
  /** After each restored file's progress row commits, with how many are stored so far. */
  afterFile?: (stored: number) => Promise<void>;
  /** After every file is stored, before the one transaction that commits the rows. */
  beforeRows?: () => Promise<void>;
}

/** An import this worker holds the lease for. */
export interface ClaimedImport {
  id: string;
  state: 'validating' | 'restoring';
  lease: string;
}

/** The import's community is no longer one it may write into; the import is cancelled. */
class ImportAbandoned extends Error {
  constructor() {
    super('The import can no longer finish');
    this.name = 'ImportAbandoned';
  }
}

function receivedAt(row: ImportRow): Date {
  if (!row.archive_received_at) throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
  return row.archive_received_at;
}

/** The job's lease was taken by a cancel or another worker; stop without writing. */
class LeaseLost extends Error {
  constructor() {
    super('The import lease was lost');
    this.name = 'LeaseLost';
  }
}

/** Claim the next due import to check or restore, with a lease other replicas respect. */
export async function claimImport(pool: Pool, now: Date): Promise<ClaimedImport | null> {
  return transaction(pool, async (client) => {
    const due = await client.query<{ id: string; state: 'validating' | 'restoring' }>(
      `SELECT id,state FROM community_imports
       WHERE settled_at IS NULL AND state IN ('validating','restoring') AND next_attempt_at<=$1
       ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [now]
    );
    const row = due.rows[0];
    if (!row) return null;
    const leased = await client.query<{ lease_token: string }>(
      `UPDATE community_imports SET lease_token=gen_random_uuid(),
         next_attempt_at=$2::timestamptz + ($3 * interval '1 millisecond'),updated_at=now()
       WHERE id=$1 RETURNING lease_token`,
      [row.id, now, IMPORT_LEASE_MS]
    );
    return { id: row.id, state: row.state, lease: leased.rows[0].lease_token };
  });
}

/**
 * Run `work` in a transaction that holds the import row and proves this worker still owns it:
 * the same lease, in the same state. A cancel clears the lease, so a cancelled import's worker
 * stops at its next write. Each fenced write also extends the lease.
 */
async function fenced<T>(
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
async function renewLease(pool: Pool, job: ClaimedImport): Promise<void> {
  const renewed = await pool.query(
    `UPDATE community_imports
     SET next_attempt_at=now() + ($3 * interval '1 millisecond'),updated_at=now()
     WHERE id=$1 AND lease_token=$2 AND state=$4`,
    [job.id, job.lease, IMPORT_LEASE_MS, job.state]
  );
  if (!renewed.rowCount) throw new LeaseLost();
}

async function openStaged(blobStore: BlobStore, row: ImportRow): Promise<OpenedExport> {
  if (!row.staging_blob_key || row.archive_bytes === null)
    throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
  return openExport(blobStore, {
    key: row.staging_blob_key,
    byteSize: Number(row.archive_bytes),
  });
}

/**
 * Check an uploaded export end to end without storing anything: the archive's structure, the
 * manifest and every reference in it, each file's length and SHA-256, and whether the files
 * fit the community's storage limit. A passing export pauses at `validated` with a report of
 * counts and sizes, or goes straight on to restore when the host asked for `autoCommit`.
 */
async function validate(
  pool: Pool,
  blobStore: BlobStore,
  job: ClaimedImport,
  limits: ImportLimits
): Promise<void> {
  const row = await loadImport(pool, job.id);
  if (!row?.community_id) throw new LeaseLost();
  const opened = await openStaged(blobStore, row);
  const counts = checkManifest(opened.manifest, limits, receivedAt(row));
  for (const attachment of opened.manifest.attachments) {
    for await (const _chunk of verifiedFile(opened, attachment)) {
      // Only the length and digest matter here; the bytes are stored during restore.
    }
    await renewLease(pool, job);
  }
  const { maxStorageBytes } = await readLimits(pool, row.community_id);
  const fitsStorageLimit = maxStorageBytes === null || counts.attachmentBytes <= maxStorageBytes;
  if (!fitsStorageLimit) throw new ImportFailure('STORAGE_LIMIT_REACHED');
  const report: ImportReport = {
    manifestVersion: 1,
    sourceLifecycle: opened.manifest.community.lifecycle,
    ...counts,
    countedBytes: counts.attachmentBytes,
    fitsStorageLimit,
  };
  await fenced(pool, job, (client, current) =>
    client.query(
      `UPDATE community_imports
       SET state=$2,report=$3,manifest_version=1,validated_at=now(),lease_token=NULL,
         attempts=0,next_attempt_at=now(),updated_at=now()
       WHERE id=$1`,
      [job.id, current.auto_commit ? 'restoring' : 'validated', JSON.stringify(report)]
    )
  );
}

/** Copy one verified file out of the archive to a private temporary file. */
async function stageFile(
  opened: OpenedExport,
  attachment: OpenedExport['manifest']['attachments'][number]
): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'community-import-file-'));
  const path = join(directory, 'file');
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      for await (const chunk of verifiedFile(opened, attachment)) {
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

/**
 * Store every file the export holds, then commit every row in one transaction.
 *
 * Each file is verified again, staged locally, stored under a fresh reservation, and recorded
 * in `community_import_files`; a restarted worker skips the files already recorded. Files
 * stay `stored` until the final transaction, which inserts every row with derived IDs,
 * commits every file, and marks the import `ready`, so a failure at any point leaves nothing
 * anyone can see.
 */
async function restore(
  pool: Pool,
  blobStore: BlobStore,
  job: ClaimedImport,
  limits: ImportLimits,
  hooks: ImportWorkerHooks
): Promise<void> {
  const row = await loadImport(pool, job.id);
  if (!row?.community_id) throw new LeaseLost();
  const communityId = row.community_id;
  const opened = await openStaged(blobStore, row);
  checkManifest(opened.manifest, limits, receivedAt(row));
  const progress = await pool.query<{ source_attachment_id: string }>(
    'SELECT source_attachment_id FROM community_import_files WHERE import_id=$1',
    [job.id]
  );
  const done = new Set(progress.rows.map((file) => file.source_attachment_id));
  let stored = done.size;
  for (const attachment of opened.manifest.attachments) {
    if (done.has(attachment.id)) continue;
    const staged = await stageFile(opened, attachment);
    try {
      const reservation = await transaction(pool, (client) =>
        reserveImportBlob(client, job.id, 'attachment', 'restoring')
      );
      let blob: StoredBlob;
      try {
        blob = await blobStore.put({
          key: reservation.key,
          source: createReadStream(staged.path),
          displayName: attachment.name,
          maxBytes: attachment.byteSize,
          kind: 'attachment',
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
        if (blob.byteSize !== attachment.byteSize || blob.sha256 !== attachment.checksum)
          throw new ImportFailure('IMPORT_CHECKSUM_MISMATCH');
        await fenced(pool, job, async (client) => {
          await settleImportBlob(client, reservation, blob, 'stored');
          await client.query(
            `INSERT INTO community_import_files(import_id,source_attachment_id,blob_key,content_type)
             VALUES($1,$2,$3,$4)`,
            [job.id, attachment.id, blob.key, blob.contentType]
          );
        });
      } catch (error) {
        await discardManagedBlob(pool, blobStore, reservation, blob).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(staged.directory, { recursive: true, force: true });
    }
    await hooks.afterFile?.(++stored);
  }
  await hooks.beforeRows?.();

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
      const recorded = await client.query<{
        source_attachment_id: string;
        blob_key: string;
        content_type: string;
      }>(
        'SELECT source_attachment_id,blob_key,content_type FROM community_import_files WHERE import_id=$1',
        [job.id]
      );
      const files = new Map<string, RestoredFile>(
        recorded.rows.map((file) => [
          file.source_attachment_id,
          { blobKey: file.blob_key, contentType: file.content_type },
        ])
      );
      const keys = recorded.rows.map((file) => file.blob_key);
      const committed = await client.query(
        `UPDATE managed_blobs SET state='committed',committed_at=now()
       WHERE community_id=$1 AND blob_key=ANY($2::text[]) AND state='stored'`,
        [communityId, keys]
      );
      if (committed.rowCount !== keys.length || keys.length !== opened.manifest.attachments.length)
        throw new ImportFailure('IMPORT_STORAGE_UNAVAILABLE');
      // The limit may have been lowered since the export was checked.
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
      const ownerId = await insertImportedRows(client, {
        importId: job.id,
        communityId,
        manifest: opened.manifest,
        files,
      });
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
         lease_token=NULL,updated_at=now()
       WHERE id=$1`,
        [job.id, ownerId]
      );
      if (current.staging_blob_key)
        await queueCommittedBlobDeletion(client, communityId, current.staging_blob_key);
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

/** End a held import as failed with a redacted code. */
async function fail(pool: Pool, job: ClaimedImport, code: ImportFailureCode): Promise<void> {
  await transaction(pool, async (client) => {
    const row = await loadImport(client, job.id, 'FOR UPDATE');
    if (!row || row.lease_token !== job.lease || row.state !== job.state) return;
    await client.query(
      `UPDATE community_imports SET state='failed',failure_code=$2,lease_token=NULL,
         next_attempt_at=now(),updated_at=now() WHERE id=$1`,
      [job.id, code]
    );
    await recordHostAudit(
      client,
      { kind: 'system' },
      {
        action: 'import.fail',
        communityId: row.community_id,
        priorState: row.state,
        nextState: 'failed',
        changedFields: ['state'],
      }
    );
  });
}

/**
 * Whether an error may pass on its own: storage that failed to answer, or a lost database
 * connection. Anything else (a refusal of the rows themselves, or a fault this code did not
 * foresee) would fail the same way again, so it ends the import instead of retrying.
 */
function isTransient(error: unknown): boolean {
  // A missing object will stay missing; only storage that failed to answer may recover.
  if (error instanceof BlobStoreError)
    return error.code !== 'BLOB_TYPE_REJECTED' && error.code !== 'BLOB_NOT_FOUND';
  if (isRetryableProviderError(error)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  // Node network errors, and Postgres connection, resource, and operator-intervention classes.
  return /^E[A-Z]+$/.test(code) || /^(08|53|57)[0-9A-Z]{3}$/.test(code) || code === '40001';
}

/** End an import this worker holds as cancelled, for the teardown to remove what it left. */
async function cancel(pool: Pool, job: ClaimedImport): Promise<void> {
  await transaction(pool, async (client) => {
    const row = await loadImport(client, job.id, 'FOR UPDATE');
    if (!row || row.lease_token !== job.lease || row.state !== job.state) return;
    await client.query(
      `UPDATE community_imports SET state='cancelled',lease_token=NULL,next_attempt_at=now(),
         updated_at=now() WHERE id=$1`,
      [job.id]
    );
    await recordHostAudit(
      client,
      { kind: 'system' },
      {
        action: 'import.cancel',
        communityId: row.community_id,
        priorState: row.state,
        nextState: 'cancelled',
        changedFields: ['state'],
      }
    );
  });
}

/**
 * Check or restore one claimed import. A refusal of the export is final; a storage or
 * connection failure is retried with the cleanup backoff and becomes
 * `IMPORT_STORAGE_UNAVAILABLE` after {@link IMPORT_MAX_ATTEMPTS} tries; any other error ends
 * the import at once rather than repeating it.
 *
 * @returns Whether the import reached its next state.
 */
export async function processImport(
  pool: Pool,
  blobStore: BlobStore,
  job: ClaimedImport,
  limits: ImportLimits,
  hooks: ImportWorkerHooks = {}
): Promise<boolean> {
  try {
    if (job.state === 'validating') await validate(pool, blobStore, job, limits);
    else await restore(pool, blobStore, job, limits, hooks);
    return true;
  } catch (error) {
    if (error instanceof LeaseLost) return false;
    if (error instanceof ImportAbandoned) {
      await cancel(pool, job);
      return false;
    }
    // An error class only: a message can carry a value from the export.
    console.error('Community import stopped', error instanceof Error ? error.name : 'unknown');
    if (error instanceof ImportFailure) {
      await fail(pool, job, error.code);
      return false;
    }
    if (!isTransient(error)) {
      const code = (error as { code?: unknown } | null)?.code;
      // A database refusal of the rows is a property of the export.
      const refused = typeof code === 'string' && /^(22|23)[0-9A-Z]{3}$/.test(code);
      await fail(pool, job, refused ? 'IMPORT_ARCHIVE_INVALID' : 'IMPORT_STORAGE_UNAVAILABLE');
      return false;
    }
    const retried = await pool.query<{ attempts: number }>(
      `UPDATE community_imports SET attempts=attempts+1,
         next_attempt_at=now() + ${cleanupBackoffSql('attempts')},updated_at=now()
       WHERE id=$1 AND lease_token=$2 AND state=$3 RETURNING attempts`,
      [job.id, job.lease, job.state]
    );
    // The lease is still this worker's, so the last try can end the import itself.
    if ((retried.rows[0]?.attempts ?? 0) >= IMPORT_MAX_ATTEMPTS)
      await fail(pool, job, 'IMPORT_STORAGE_UNAVAILABLE');
    else
      await pool.query(
        'UPDATE community_imports SET lease_token=NULL WHERE id=$1 AND lease_token=$2',
        [job.id, job.lease]
      );
    return false;
  }
}
