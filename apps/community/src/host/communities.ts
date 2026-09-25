import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { CommunityAdminImportStateSchema } from '@dorkos/shared/community-admin-wire';
import { transaction } from '../data.js';
import { ApiError } from '../http.js';
import type { BlobStore } from '../storage/index.js';
import { withReconciledTenantNamespace } from '../storage/tenant-reconciliation.js';

/** One community row as the host plane reads it: metadata and state, never content. */
export interface HostCommunityRow {
  id: string;
  name: string;
  description: string | null;
  lifecycle: 'pending_owner' | 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending';
  lifecycle_version: number;
  settings_version: number;
  created_at: Date;
  owner_present: boolean;
  deletion_state: 'waiting' | 'deleting' | 'retrying' | null;
  suspended_from_state?: 'active' | 'archived' | 'held' | null;
  held_from_state?: 'active' | 'archived' | null;
  deletion_notice_at: Date | null;
  deletion_requested_by: 'owner' | 'host' | null;
  short_name: string | null;
  import_id: string | null;
  import_state: z.infer<typeof CommunityAdminImportStateSchema> | null;
}

/** The host projection of one community row. */
export function projectCommunity(row: HostCommunityRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lifecycle: row.lifecycle,
    lifecycleVersion: row.lifecycle_version,
    settingsVersion: row.settings_version,
    ownerPresent: row.owner_present,
    deletionState: row.deletion_state,
    deletionNoticeAt: row.deletion_notice_at?.toISOString() ?? null,
    deletionRequestedBy: row.deletion_requested_by,
    shortName: row.short_name,
    importId: row.import_id,
    importState: row.import_state,
    createdAt: row.created_at.toISOString(),
  };
}

/** Select every host-visible column; append a `WHERE` or `ORDER BY` for the rows wanted. */
export const hostProjectionSql = `SELECT c.id,c.name,c.description,c.lifecycle,c.lifecycle_version,
  c.settings_version,c.created_at,c.suspended_from_state,c.held_from_state,c.deletion_notice_at,
  CASE WHEN c.delete_requested_by_host_actor IS NOT NULL THEN 'host'
       WHEN c.delete_requested_by IS NOT NULL THEN 'owner' END AS deletion_requested_by,
  (SELECT n.short_name FROM community_short_names n
    WHERE n.community_id=c.id AND n.state='current') AS short_name,
  EXISTS(SELECT 1 FROM members m WHERE m.community_id=c.id AND m.role='owner' AND m.active) AS owner_present,
  j.state AS deletion_state,i.id AS import_id,i.state AS import_state
  FROM communities c LEFT JOIN community_deletion_jobs j ON j.community_id=c.id
  LEFT JOIN community_imports i ON i.community_id=c.id`;

/** Parse a host route's community id; a malformed id is the same 404 as an unknown one. */
export function parseHostCommunityId(value: string | undefined): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
  return parsed.data;
}

/** Revoke every invitation, pairing, personal grant, and agent credential for a tenant. */
export async function revokeTenantAccess(client: PoolClient, communityId: string): Promise<void> {
  await client.query(
    'UPDATE invites SET revoked_at=COALESCE(revoked_at,now()) WHERE community_id=$1',
    [communityId]
  );
  await client.query('DELETE FROM pending_admissions WHERE community_id=$1', [communityId]);
  await client.query(
    'UPDATE connection_pairings SET cancelled_at=COALESCE(cancelled_at,now()) WHERE community_id=$1 AND consumed_at IS NULL',
    [communityId]
  );
  await client.query(
    'UPDATE connection_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE community_id=$1',
    [communityId]
  );
  await client.query(
    'UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE community_id=$1',
    [communityId]
  );
  await client.query(
    'UPDATE agents SET active=false,revoked_at=COALESCE(revoked_at,now()) WHERE community_id=$1',
    [communityId]
  );
}

/**
 * Run a transaction that creates a host's second or later community.
 *
 * A host must finish first installation before any other community exists, and the step from
 * one community to two runs inside the tenant reconciliation gate, which proves every stored
 * file belongs to the first community before a second one can own files.
 */
export async function createCommunityGated<T>(
  pool: Pool,
  blobStore: BlobStore,
  create: (client: PoolClient) => Promise<T>
): Promise<T> {
  const count = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM communities'
  );
  if (count.rows[0].count === 0) {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'Complete first installation before creating another community.'
    );
  }
  if (count.rows[0].count > 1) return transaction(pool, create);
  const gated = await withReconciledTenantNamespace(pool, blobStore, create);
  if (!gated.reconciliation.ready || !gated.value) {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'Storage ownership must be reconciled before creating another community.'
    );
  }
  return gated.value;
}
