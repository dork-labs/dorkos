import type { Pool, PoolClient } from 'pg';
import { requireLiveRole, refuseIfClearedSinceStart, type Member } from '../../data.js';
import { ApiError } from '../../http.js';
import { isReadOnlyLifecycle } from '../../tenant-context.js';

// Who and what a pairing request may be decided by, beside `pairings.ts`, which routes them.

/** The scopes a pairing request asked for, or none when it is not this space's. */
export async function pairingScopes(
  pool: Pool,
  id: string,
  communityId: string
): Promise<string[]> {
  const result = await pool.query<{ scopes: string[] }>(
    'SELECT scopes FROM connection_pairings WHERE id=$1 AND community_id=$2',
    [id, communityId]
  );
  return result.rows[0]?.scopes ?? [];
}

/** Lock the space a pairing is for, refusing a lifecycle that cannot pair this request. */
export async function lockPairingCommunity(
  client: PoolClient,
  communityId: string,
  allowArchivedRead: boolean
): Promise<'active' | 'archived'> {
  const result = await client.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
    [communityId]
  );
  const lifecycle = result.rows[0]?.lifecycle;
  if (lifecycle === 'active') return lifecycle;
  // A held community pairs exactly as an archived one: read-only, history only.
  if (isReadOnlyLifecycle(lifecycle) && allowArchivedRead) return 'archived';
  if (lifecycle === 'archived')
    throw new ApiError(423, 'COMMUNITY_ARCHIVED', 'Archived spaces accept read-only pairing.');
  if (lifecycle === 'held')
    throw new ApiError(423, 'COMMUNITY_HELD', 'Held spaces accept read-only pairing.');
  if (lifecycle === 'suspended')
    throw new ApiError(503, 'COMMUNITY_SUSPENDED', 'This space is suspended.');
  if (lifecycle === 'deletion_pending')
    throw new ApiError(423, 'COMMUNITY_DELETION_PENDING', 'This space is being deleted.');
  throw new ApiError(409, 'COMMUNITY_UNAVAILABLE', 'This space is unavailable.');
}

/** Check the member deciding on a pairing; their live role in an active space, else null. */
export async function requirePairingMember(
  client: PoolClient,
  actor: Member,
  lifecycle: 'active' | 'archived'
): Promise<Member['role'] | null> {
  if (lifecycle === 'active') return requireLiveRole(client, actor, ['owner', 'admin', 'member']);
  await refuseIfClearedSinceStart(client, actor.user_id);
  const member = await client.query(
    // member-kind: by-grant
    'SELECT 1 FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
    [actor.id, actor.community_id]
  );
  if (!member.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
  return null;
}

/**
 * What a grant can do right now, from its scopes and the lifecycle an installation is told.
 *
 * A held community is reported as `archived`, and read-only either way: a grant kept through a
 * hold reads, and posts, enrolls agents, and streams again only after release. A history-only
 * grant never gains write access, whatever the lifecycle.
 *
 * @param scopes - The grant's scopes.
 * @param historyOnly - Whether the grant may only read history.
 * @param lifecycle - The lifecycle the installation is told.
 */
export function grantCapabilities(
  scopes: readonly string[],
  historyOnly: boolean,
  lifecycle: 'active' | 'archived'
) {
  const live = lifecycle === 'active' && !historyOnly;
  return {
    read: scopes.includes('read'),
    post: live && scopes.includes('post'),
    enrollAgent: live && scopes.includes('enroll-agent'),
    stream: live && scopes.includes('read'),
  };
}

/**
 * Whether a pairing asks for exactly `read`: the one request an archived space still pairs.
 *
 * @param scopes - The scopes the pairing asked for.
 */
export function exactArchivedRead(scopes: readonly string[]): boolean {
  return scopes.length === 1 && scopes[0] === 'read';
}
