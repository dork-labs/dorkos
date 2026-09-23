import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError } from './http.js';

/** One community row as the host plane reads it: metadata and state, never content. */
export interface HostCommunityRow {
  id: string;
  name: string;
  description: string | null;
  lifecycle: 'pending_owner' | 'active' | 'archived' | 'suspended' | 'deletion_pending';
  lifecycle_version: number;
  settings_version: number;
  created_at: Date;
  owner_present: boolean;
  deletion_state: 'waiting' | 'deleting' | 'retrying' | null;
  suspended_from_state?: 'active' | 'archived' | null;
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
    createdAt: row.created_at.toISOString(),
  };
}

/** Select every host-visible column; append a `WHERE` or `ORDER BY` for the rows wanted. */
export const hostProjectionSql = `SELECT c.id,c.name,c.description,c.lifecycle,c.lifecycle_version,
  c.settings_version,c.created_at,c.suspended_from_state,
  EXISTS(SELECT 1 FROM members m WHERE m.community_id=c.id AND m.role='owner' AND m.active) AS owner_present,
  j.state AS deletion_state
  FROM communities c LEFT JOIN community_deletion_jobs j ON j.community_id=c.id`;

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
