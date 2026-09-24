import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { BlobStore } from './blob-store.js';

const RECONCILIATION_LOCK = "hashtext('dorkos:tenant-reconciliation')";

type Purpose = 'attachment' | 'export';

interface ReferenceRow {
  blob_key: string;
  community_id: string;
  purpose: Purpose;
  byte_size: string;
  checksum: string | null;
  lifecycle_version: number;
}

interface ManagedRow {
  blob_key: string;
  community_id: string;
  purpose: Purpose | 'legacy_cleanup';
  // `evidence_hold` bytes are owned and left alone: no reference names them, and none is needed.
  state: 'reserved' | 'stored' | 'committed' | 'pending_delete' | 'evidence_hold';
  byte_size: string | null;
  checksum: string | null;
  lease_expired: boolean;
}

/** Redacted reason that keeps reconciliation blocked without exposing object keys. */
export interface TenantReconciliationIssue {
  code:
    | 'active_writes'
    | 'ambiguous_database'
    | 'incomplete_listing'
    | 'metadata_mismatch'
    | 'missing_object'
    | 'unexplained_objects';
  count: number;
  instruction: string;
}

/** Redacted result of the zero/one-community namespace reconciliation gate. */
export interface TenantReconciliationResult {
  ready: boolean;
  generation: number;
  counts: {
    communities: number;
    referenced: number;
    cleanup: number;
    unexplained: number;
  };
  issues: TenantReconciliationIssue[];
}

/**
 * Reconcile legacy file ownership while the database still has at most one community.
 *
 * The session advisory lock excludes current reservation writers across the complete storage
 * listing and final generation check. Mutation triggers detect database writes from older binaries;
 * operators must quiesce old instances, and the later tenant-creation gate repeats the listing.
 */
export async function reconcileTenantNamespace(
  pool: Pool,
  blobStore: BlobStore
): Promise<TenantReconciliationResult> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${RECONCILIATION_LOCK})`);
    return await reconcileWithLock(client, blobStore);
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${RECONCILIATION_LOCK})`).catch(() => {});
    client.release();
  }
}

/**
 * Reconcile and run the second-community admission transaction under the same writer fence.
 *
 * The callback runs only after a complete ready result and must recheck the durable generation
 * inside its transaction before inserting the second community.
 */
export async function withReconciledTenantNamespace<T>(
  pool: Pool,
  blobStore: BlobStore,
  operation: (client: PoolClient, reconciliation: TenantReconciliationResult) => Promise<T>
): Promise<{ reconciliation: TenantReconciliationResult; value?: T }> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${RECONCILIATION_LOCK})`);
    const reconciliation = await reconcileWithLock(client, blobStore);
    if (!reconciliation.ready) return { reconciliation };
    await client.query('BEGIN');
    try {
      const gate = await client.query<{
        generation: string;
        validated_generation: string | null;
        state: string;
      }>(
        `SELECT generation,validated_generation,state
         FROM tenant_reconciliation WHERE singleton FOR UPDATE`
      );
      const current = gate.rows[0];
      if (
        current?.state !== 'ready' ||
        Number(current.generation) !== reconciliation.generation ||
        Number(current.validated_generation) !== reconciliation.generation
      ) {
        throw new Error('Tenant reconciliation changed before community creation');
      }
      const value = await operation(client, reconciliation);
      await client.query('COMMIT');
      return { reconciliation, value };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${RECONCILIATION_LOCK})`).catch(() => {});
    client.release();
  }
}

async function reconcileWithLock(
  client: PoolClient,
  blobStore: BlobStore
): Promise<TenantReconciliationResult> {
  const gate = await client.query<{ generation: string }>(
    'SELECT generation FROM tenant_reconciliation WHERE singleton'
  );
  if (!gate.rows[0]) throw new Error('Tenant reconciliation migration is not installed');
  const generation = Number(gate.rows[0].generation);
  const communities = await client.query<{ id: string; lifecycle_version: number }>(
    'SELECT id,lifecycle_version FROM communities ORDER BY id'
  );
  const counts = {
    communities: communities.rowCount ?? 0,
    referenced: 0,
    cleanup: 0,
    unexplained: 0,
  };
  if (communities.rows.length > 1) {
    return block(client, generation, counts, [
      issue('ambiguous_database', 1, 'Restore a zero- or one-community backup before retrying.'),
    ]);
  }

  const unresolved = await client.query<{ count: string }>(
    `SELECT sum(count)::text AS count FROM (
       SELECT count(*) FROM invite_uses WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM pending_admissions WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM connection_pairings WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM connection_grants WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM channel_members WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM agent_credentials WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM agent_channel_members WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM entries WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM attachments WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM export_archives WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM read_cursors WHERE community_id IS NULL
       UNION ALL SELECT count(*) FROM owner_quota_windows WHERE community_id IS NULL
     ) unresolved`
  );
  const unresolvedCount = Number(unresolved.rows[0]?.count ?? 0);
  if (unresolvedCount) {
    return block(client, generation, counts, [
      issue(
        'ambiguous_database',
        unresolvedCount,
        'Stop the legacy writer and restore explicit tenant ownership before retrying.'
      ),
    ]);
  }

  let snapshot;
  try {
    snapshot = await blobStore.listNamespace();
  } catch {
    return block(client, generation, counts, [
      issue(
        'incomplete_listing',
        1,
        'Repair authoritative object listing and retry without changing object ownership.'
      ),
    ]);
  }

  const references = await client.query<ReferenceRow>(
    `SELECT a.blob_key,a.community_id,'attachment'::text AS purpose,
            a.byte_size::text,a.checksum,c.lifecycle_version
     FROM attachments a JOIN communities c ON c.id=a.community_id
     UNION ALL
     SELECT e.blob_key,e.community_id,'export'::text AS purpose,
            e.byte_size::text,NULL::text AS checksum,c.lifecycle_version
     FROM export_archives e JOIN communities c ON c.id=e.community_id`
  );
  const managed = await client.query<ManagedRow>(
    `SELECT blob_key,community_id,purpose,state,byte_size::text,checksum,
            created_at<=now()-interval '1 hour' AS lease_expired
     FROM managed_blobs`
  );
  const pending = await client.query<{ blob_key: string }>(
    'SELECT blob_key FROM pending_blob_deletions'
  );
  counts.referenced = references.rows.length;

  const issues: TenantReconciliationIssue[] = [];
  const referenceByKey = new Map<string, ReferenceRow>();
  for (const reference of references.rows) {
    if (referenceByKey.has(reference.blob_key)) {
      issues.push(
        issue('ambiguous_database', 1, 'Resolve duplicate file references before retrying.')
      );
    }
    referenceByKey.set(reference.blob_key, reference);
  }
  const managedByKey = new Map(managed.rows.map((row) => [row.blob_key, row]));
  const pendingKeys = new Set(pending.rows.map((row) => row.blob_key));
  const listedKeys = new Set(snapshot.keys);

  const activeKeys = new Set(
    managed.rows
      .filter((row) => ['reserved', 'stored'].includes(row.state) && !row.lease_expired)
      .map((row) => row.blob_key)
  );
  if (activeKeys.size) {
    issues.push(
      issue('active_writes', activeKeys.size, 'Wait for active file writes to finish, then retry.')
    );
  }
  const referencedCleanup = [...pendingKeys].filter((key) => referenceByKey.has(key)).length;
  if (referencedCleanup) {
    issues.push(
      issue(
        'metadata_mismatch',
        referencedCleanup,
        'Resolve cleanup work that still names referenced content before retrying.'
      )
    );
  }
  const unexplainedTemporary = snapshot.temporaryKeys.filter((key) => !activeKeys.has(key)).length;
  if (snapshot.unexpectedEntries || unexplainedTemporary) {
    counts.unexplained += snapshot.unexpectedEntries + unexplainedTemporary;
    issues.push(
      issue(
        'unexplained_objects',
        snapshot.unexpectedEntries + unexplainedTemporary,
        'Inspect the private storage namespace and record ownership before retrying; no object was deleted.'
      )
    );
  }

  for (const reference of references.rows) {
    if (!listedKeys.has(reference.blob_key)) {
      issues.push(
        issue('missing_object', 1, 'Restore missing referenced file bytes before retrying.')
      );
      continue;
    }
    const stored = managedByKey.get(reference.blob_key);
    if (
      stored &&
      (stored.community_id !== reference.community_id ||
        stored.purpose !== reference.purpose ||
        stored.state === 'pending_delete')
    ) {
      issues.push(
        issue('metadata_mismatch', 1, 'Resolve conflicting file ownership before retrying.')
      );
      continue;
    }
    let digest;
    try {
      digest = await digestBlob(blobStore, reference.blob_key);
    } catch {
      issues.push(
        issue('missing_object', 1, 'Restore readable referenced file bytes before retrying.')
      );
      continue;
    }
    if (
      digest.byteSize !== Number(reference.byte_size) ||
      (reference.checksum !== null && digest.checksum !== reference.checksum) ||
      (stored !== undefined &&
        stored.byte_size !== null &&
        stored.byte_size !== String(digest.byteSize)) ||
      (stored !== undefined && stored.checksum !== null && stored.checksum !== digest.checksum)
    ) {
      issues.push(issue('metadata_mismatch', 1, 'Restore verified file bytes before retrying.'));
    }
    reference.checksum = digest.checksum;
  }

  for (const row of managed.rows) {
    if (row.state === 'committed' && !referenceByKey.has(row.blob_key)) {
      issues.push(
        issue('metadata_mismatch', 1, 'Resolve committed inventory without a content reference.')
      );
    }
  }

  const unownedListed = snapshot.keys.filter(
    (key) => !referenceByKey.has(key) && !managedByKey.has(key) && !pendingKeys.has(key)
  );
  if (unownedListed.length) {
    counts.unexplained += unownedListed.length;
    issues.push(
      issue(
        'unexplained_objects',
        unownedListed.length,
        'Assign or remove unexplained objects through a reviewed recovery procedure, then retry; no object was deleted.'
      )
    );
  }
  if (pendingKeys.size && communities.rows.length === 0) {
    counts.unexplained += pendingKeys.size;
    issues.push(
      issue(
        'ambiguous_database',
        pendingKeys.size,
        'Resolve cleanup ownership before bootstrapping the first community.'
      )
    );
  }
  if (issues.length) return block(client, generation, counts, coalesceIssues(issues));

  const community = communities.rows[0];
  const cleanupKeys = new Set<string>();
  if (community) {
    for (const key of pendingKeys) cleanupKeys.add(key);
    for (const row of managed.rows) {
      if (
        row.state === 'pending_delete' ||
        ((row.state === 'reserved' || row.state === 'stored') && row.lease_expired)
      ) {
        cleanupKeys.add(row.blob_key);
      }
    }
  }
  counts.cleanup = cleanupKeys.size;
  const namespaceDigest = createHash('sha256')
    .update(
      [
        ...snapshot.keys.map((key) => `object:${key}`),
        ...references.rows.map(
          (row) => `reference:${row.purpose}:${row.blob_key}:${row.byte_size}:${row.checksum}`
        ),
        ...[...cleanupKeys].map((key) => `cleanup:${key}`),
      ]
        .sort()
        .join('\n')
    )
    .digest('hex');

  await client.query('BEGIN');
  try {
    if (community) {
      await client.query("SELECT set_config('dorkos.tenant_reconciliation','backfill',true)");
      for (const reference of references.rows) {
        await client.query(
          `INSERT INTO managed_blobs(
             blob_key,community_id,purpose,community_lifecycle_version,state,
             byte_size,checksum,stored_at,committed_at
           ) VALUES($1,$2,$3,$4,'committed',$5,$6,now(),now())
           ON CONFLICT(blob_key) DO UPDATE SET
             state='committed',byte_size=EXCLUDED.byte_size,checksum=EXCLUDED.checksum,
             stored_at=EXCLUDED.stored_at,committed_at=EXCLUDED.committed_at
           WHERE managed_blobs.community_id=EXCLUDED.community_id
             AND managed_blobs.purpose=EXCLUDED.purpose
             AND managed_blobs.state IN ('reserved','stored','committed')`,
          [
            reference.blob_key,
            reference.community_id,
            reference.purpose,
            reference.lifecycle_version,
            reference.byte_size,
            reference.checksum,
          ]
        );
      }
      for (const key of cleanupKeys) {
        const existing = managedByKey.get(key);
        if (existing) {
          await client.query(
            `UPDATE managed_blobs SET state='pending_delete'
             WHERE blob_key=$1 AND community_id=$2 AND state<>'committed'`,
            [key, community.id]
          );
        } else {
          await client.query(
            `INSERT INTO managed_blobs(
               blob_key,community_id,purpose,community_lifecycle_version,state
             ) VALUES($1,$2,'legacy_cleanup',$3,'pending_delete')`,
            [key, community.id, community.lifecycle_version]
          );
        }
        await client.query(
          `INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at)
           VALUES($1,0,now()) ON CONFLICT(blob_key) DO NOTHING`,
          [key]
        );
      }
    }
    // Database writers invalidate at commit after releasing neither domain nor inventory
    // locks. Take the generation row only after reconciliation's own inventory writes so every
    // transaction follows the same domain/inventory -> generation order.
    const current = await client.query<{ generation: string }>(
      'SELECT generation FROM tenant_reconciliation WHERE singleton FOR UPDATE'
    );
    const currentGeneration = Number(current.rows[0]?.generation);
    if (currentGeneration !== generation) {
      await client.query('ROLLBACK');
      return block(client, currentGeneration, counts, [
        issue(
          'active_writes',
          1,
          'A database write raced reconciliation; retry from a fresh listing.'
        ),
      ]);
    }
    await client.query(
      `UPDATE tenant_reconciliation
       SET state='ready',validated_generation=generation,community_id=$1,
           namespace_digest=$2,completed_at=now(),reason_code='validated'
       WHERE singleton`,
      [community?.id ?? null, namespaceDigest]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return { ready: true, generation, counts, issues: [] };
}

async function digestBlob(blobStore: BlobStore, key: string) {
  const read = await blobStore.get(key);
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of read.body) {
    const bytes = Buffer.from(chunk);
    byteSize += bytes.length;
    hash.update(bytes);
  }
  return { byteSize, checksum: hash.digest('hex') };
}

function issue(
  code: TenantReconciliationIssue['code'],
  count: number,
  instruction: string
): TenantReconciliationIssue {
  return { code, count, instruction };
}

function coalesceIssues(issues: TenantReconciliationIssue[]): TenantReconciliationIssue[] {
  const result = new Map<string, TenantReconciliationIssue>();
  for (const item of issues) {
    const prior = result.get(item.code);
    if (prior) prior.count += item.count;
    else result.set(item.code, { ...item });
  }
  return [...result.values()];
}

async function block(
  client: PoolClient,
  generation: number,
  counts: TenantReconciliationResult['counts'],
  issues: TenantReconciliationIssue[]
): Promise<TenantReconciliationResult> {
  await client.query(
    `UPDATE tenant_reconciliation
     SET state='dirty',validated_generation=NULL,completed_at=NULL,
         namespace_digest=NULL,invalidated_at=now(),reason_code=$2
     WHERE singleton AND generation=$1`,
    [generation, issues[0]?.code ?? 'reconciliation_blocked']
  );
  return { ready: false, generation, counts, issues };
}
