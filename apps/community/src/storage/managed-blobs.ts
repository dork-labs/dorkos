import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../data.js';
import { ApiError } from '../http.js';
import type { BlobStore, StoredBlob } from './blob-store.js';

/** Maximum time an attachment or export writer owns an active reservation. */
export const MANAGED_BLOB_RESERVATION_TTL_MS = 60 * 60 * 1000;

/** Tenant ownership reserved before an attachment or export reaches storage. */
export interface ManagedBlobReservation {
  key: string;
  communityId: string;
  purpose: 'attachment' | 'export';
  lifecycleVersion: number;
}

/** Reserve one opaque key against the community's current active lifecycle. */
export async function reserveManagedBlob(
  client: PoolClient,
  communityId: string,
  purpose: ManagedBlobReservation['purpose']
): Promise<ManagedBlobReservation> {
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtext('dorkos:tenant-reconciliation'))"
  );
  const result = await client.query<{ lifecycle: string; lifecycle_version: number }>(
    'SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1 FOR SHARE',
    [communityId]
  );
  const community = result.rows[0];
  if (!community || community.lifecycle !== 'active') {
    throw new ApiError(409, 'STATE_CONFLICT', 'This community is not accepting new files.');
  }
  const reservation = {
    key: randomBytes(32).toString('hex'),
    communityId,
    purpose,
    lifecycleVersion: community.lifecycle_version,
  };
  await client.query(
    `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state)
     VALUES($1,$2,$3,$4,'reserved')`,
    [reservation.key, communityId, purpose, reservation.lifecycleVersion]
  );
  return reservation;
}

/** Recheck lifecycle and move a reservation to stored inside its reference transaction. */
export async function prepareManagedBlobCommit(
  client: PoolClient,
  reservation: ManagedBlobReservation,
  stored: StoredBlob
): Promise<void> {
  if (stored.key !== reservation.key) throw new Error('Stored blob key changed after reservation');
  const result = await client.query<{ lifecycle: string; lifecycle_version: number }>(
    'SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1 FOR SHARE',
    [reservation.communityId]
  );
  const community = result.rows[0];
  if (
    !community ||
    community.lifecycle !== 'active' ||
    community.lifecycle_version !== reservation.lifecycleVersion
  ) {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'The community changed while the file was uploading.'
    );
  }
  const updated = await client.query(
    `UPDATE managed_blobs
     SET state='stored',byte_size=$2,checksum=$3,stored_at=now()
     WHERE blob_key=$1 AND community_id=$4 AND purpose=$5
       AND community_lifecycle_version=$6 AND state='reserved'
       AND created_at>now()-interval '1 hour'`,
    [
      reservation.key,
      stored.byteSize,
      stored.sha256,
      reservation.communityId,
      reservation.purpose,
      reservation.lifecycleVersion,
    ]
  );
  if (updated.rowCount !== 1) {
    throw new ApiError(409, 'STATE_CONFLICT', 'The file reservation expired before it committed.');
  }
}

/** Bound storage I/O to the same finite lease enforced by reference commit. */
export function managedBlobWriteSignal(requestSignal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(MANAGED_BLOB_RESERVATION_TTL_MS);
  return requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline;
}

/** Mark stored inventory committed after its content reference is inserted. */
export async function completeManagedBlobCommit(
  client: PoolClient,
  reservation: ManagedBlobReservation
): Promise<void> {
  const updated = await client.query(
    `UPDATE managed_blobs SET state='committed',committed_at=now()
     WHERE blob_key=$1 AND community_id=$2 AND state='stored'`,
    [reservation.key, reservation.communityId]
  );
  if (updated.rowCount !== 1) throw new Error('Managed blob metadata did not commit');
}

/** Delete an uncommitted object or retain tenant-qualified retry work on failure. */
export async function discardManagedBlob(
  pool: Pool,
  blobStore: BlobStore,
  reservation: ManagedBlobReservation,
  stored?: StoredBlob
): Promise<void> {
  const transitioned = await transaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE managed_blobs
       SET state='pending_delete',byte_size=$2,checksum=$3,stored_at=$4
       WHERE blob_key=$1 AND community_id=$5 AND state IN ('reserved','stored')`,
      [
        reservation.key,
        stored?.byteSize ?? null,
        stored?.sha256 ?? null,
        stored ? new Date() : null,
        reservation.communityId,
      ]
    );
    if (result.rowCount !== 1) return false;
    await client.query(
      `INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at)
       VALUES($1,0,now())
       ON CONFLICT(blob_key) DO NOTHING`,
      [reservation.key]
    );
    return true;
  });
  if (!transitioned) return;
  try {
    await blobStore.delete(reservation.key);
  } catch (error) {
    await pool.query(
      `UPDATE pending_blob_deletions
       SET attempts=attempts+1,last_error_at=now(),next_attempt_at=now()+interval '1 minute'
       WHERE blob_key=$1`,
      [reservation.key]
    );
    console.error(
      'Community managed blob cleanup deferred',
      error instanceof Error ? error.name : 'unknown'
    );
    return;
  }
  await transaction(pool, async (client) => {
    await client.query(
      `DELETE FROM managed_blobs m
       WHERE m.blob_key=$1 AND m.community_id=$2 AND m.state='pending_delete'
         AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.blob_key=m.blob_key)
         AND NOT EXISTS(SELECT 1 FROM export_archives e WHERE e.blob_key=m.blob_key)`,
      [reservation.key, reservation.communityId]
    );
    await client.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [reservation.key]);
  });
}
