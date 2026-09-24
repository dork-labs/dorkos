import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError } from '../http.js';
import type { HostActor } from './authority.js';

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
  legal_hold_at: Date | null;
  legal_hold_reference: string | null;
}

/**
 * Whether an actor may read a legal hold's reference: a host person, or a key with
 * `communities:legal_hold`. Anyone else who can read the record sees that a hold exists and
 * since when (it explains a paused deletion) but never the reference, which may name a case.
 */
export function canReadLegalHoldReference(actor: HostActor): boolean {
  return actor.kind === 'person' || actor.scopes.includes('communities:legal_hold');
}

/** The host projection of one community row, as `actor` may see it. */
export function projectCommunity(row: HostCommunityRow, actor: HostActor) {
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
    legalHold: row.legal_hold_at
      ? {
          since: row.legal_hold_at.toISOString(),
          reference: canReadLegalHoldReference(actor) ? row.legal_hold_reference : null,
        }
      : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** Select every host-visible column; append a `WHERE` or `ORDER BY` for the rows wanted. */
export const hostProjectionSql = `SELECT c.id,c.name,c.description,c.lifecycle,c.lifecycle_version,
  c.settings_version,c.created_at,c.suspended_from_state,c.held_from_state,c.deletion_notice_at,
  c.legal_hold_at,c.legal_hold_reference,
  CASE WHEN c.delete_requested_by_host_actor IS NOT NULL THEN 'host'
       WHEN c.delete_requested_by IS NOT NULL THEN 'owner' END AS deletion_requested_by,
  (SELECT n.short_name FROM community_short_names n
    WHERE n.community_id=c.id AND n.state='current') AS short_name,
  EXISTS(SELECT 1 FROM members m WHERE m.community_id=c.id AND m.role='owner' AND m.active) AS owner_present,
  j.state AS deletion_state
  FROM communities c LEFT JOIN community_deletion_jobs j ON j.community_id=c.id`;

/**
 * The host's refusal when its own legal hold stands in the way of deleting a community. Only
 * host routes use it: owners and members are never told a legal hold exists.
 */
export function legalHoldActive(): ApiError {
  return new ApiError(
    409,
    'LEGAL_HOLD_ACTIVE',
    'This community is under a legal hold. Release the hold before deleting it.'
  );
}

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
