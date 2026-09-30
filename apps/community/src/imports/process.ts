import type { Pool } from 'pg';
import { transaction } from '../data.js';
import { recordHostAudit } from '../host/authority.js';
import { readLimits } from '../host/limits.js';
import { BlobStoreError, type BlobStore } from '../storage/index.js';
import { isRetryableProviderError } from '../storage/blob-store.js';
import { cleanupBackoffSql } from '../storage/pending-deletions.js';
import { openExport, readManifestVersion, verifiedFile } from './archive.js';
import {
  fenced,
  finishRestore,
  ImportAbandoned,
  importSource,
  LeaseLost,
  receivedAt,
  renewLease,
  restoredFiles,
  storeRestoredFile,
  type ClaimedImport,
} from './job.js';
import { checkManifest, ImportFailure, type ImportLimits } from './manifest.js';
import { insertImportedRows } from './restore.js';
import { IMPORT_LEASE_MS, loadImport, type ImportFailureCode, type ImportReport } from './store.js';
import { restoreV2, validateV2 } from './v2-process.js';

export type { ClaimedImport } from './job.js';

/** Storage failures an import retries before it fails as `IMPORT_STORAGE_UNAVAILABLE`. */
export const IMPORT_MAX_ATTEMPTS = 8;

/** Test seams: pause or stop the worker at the two points a crash matters most. */
export interface ImportWorkerHooks {
  /** After each restored file's progress row commits, with how many are stored so far. */
  afterFile?: (stored: number) => Promise<void>;
  /** After every file is stored, before the rows (version 1: the one transaction). */
  beforeRows?: () => Promise<void>;
  /** Version 2: after each batch of rows commits with its progress, with batches so far. */
  afterBatch?: (batches: number) => Promise<void>;
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
 * Check an uploaded export end to end without storing anything: the archive's structure, the
 * manifest and every row in it, each file's length and SHA-256, and whether the files fit the
 * community's storage limit. A passing export pauses at `validated` with a report of counts and
 * sizes, or goes straight on to restore when the host asked for `autoCommit`.
 *
 * The version its manifest names picks the rules: version 1 (one manifest holding every row)
 * or version 2 (rows in NDJSON files, any size; see `v2-process.ts`). Any other version fails
 * as `IMPORT_VERSION_UNSUPPORTED`.
 */
async function validate(
  pool: Pool,
  blobStore: BlobStore,
  job: ClaimedImport,
  limits: ImportLimits
): Promise<void> {
  const row = await loadImport(pool, job.id);
  if (!row?.community_id) throw new LeaseLost();
  const source = await importSource(pool, blobStore, row);
  const version = await readManifestVersion(source);
  let report: ImportReport;
  if (version === 2) {
    report = await validateV2(pool, job, row, source, limits);
  } else {
    const opened = await openExport(source);
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
    report = {
      manifestVersion: 1,
      sourceLifecycle: opened.manifest.community.lifecycle,
      ...counts,
      countedBytes: counts.attachmentBytes,
      fitsStorageLimit,
    };
  }
  await fenced(pool, job, (client, current) =>
    client.query(
      `UPDATE community_imports
       SET state=$2,report=$3,manifest_version=$4,validated_at=now(),lease_token=NULL,
         attempts=0,next_attempt_at=now(),updated_at=now()
       WHERE id=$1`,
      [
        job.id,
        current.auto_commit ? 'restoring' : 'validated',
        JSON.stringify(report),
        report.manifestVersion,
      ]
    )
  );
}

/**
 * Restore a checked export in the version it was checked as.
 *
 * Version 1: store every file, then commit every row in one transaction. Each file is
 * verified again, staged locally, stored under a fresh reservation, and recorded in
 * `community_import_files`; a restarted worker skips the files already recorded. Files stay
 * `stored` until the final transaction, which inserts every row with derived IDs, commits
 * every file, and marks the import `ready`, so a failure at any point leaves nothing anyone
 * can see. Version 2 restores in resumable batches (see `v2-process.ts`).
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
  const source = await importSource(pool, blobStore, row);
  if (row.manifest_version === 2) {
    await restoreV2(pool, blobStore, job, row, source, limits, hooks);
    return;
  }
  const opened = await openExport(source);
  checkManifest(opened.manifest, limits, receivedAt(row));
  const progress = await pool.query<{ source_attachment_id: string }>(
    'SELECT source_attachment_id FROM community_import_files WHERE import_id=$1',
    [job.id]
  );
  const done = new Set(progress.rows.map((file) => file.source_attachment_id));
  let stored = done.size;
  for (const attachment of opened.manifest.attachments) {
    if (done.has(attachment.id)) continue;
    await storeRestoredFile(pool, blobStore, job, {
      sourceId: attachment.id,
      purpose: 'attachment',
      displayName: attachment.name,
      byteSize: attachment.byteSize,
      checksum: attachment.checksum,
      bytes: () => verifiedFile(opened, attachment),
    });
    await hooks.afterFile?.(++stored);
  }
  await hooks.beforeRows?.();

  await finishRestore(pool, job, communityId, opened.manifest.attachments.length, async (client) =>
    insertImportedRows(client, {
      importId: job.id,
      communityId,
      manifest: opened.manifest,
      files: await restoredFiles(client, job.id),
    })
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
