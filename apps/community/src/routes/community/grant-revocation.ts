/** Ending a personal connection grant: by its own bearer, or by the member who holds it. */
import type { Context } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { bearer, transaction, type requireMember } from '../../data.js';
import { ApiError } from '../../http.js';
import { hashSecret } from '../../security.js';
import { resolveCommunityContext } from '../../tenant-context.js';
import { notifyLive } from '../../live/notices.js';

/**
 * Revoke the personal grant whose bearer made this request.
 *
 * This is how a local install disconnects itself: it holds only its own
 * bearer, never the person's browser session, so the bearer is the proof. It
 * works in every lifecycle a person can still revoke from (a suspended or
 * closing community must still let an install go) and does not require the
 * grant's scopes or a live membership, because ending access is always safe.
 * A bearer whose grant is already revoked succeeds again, so a retry after a
 * lost response is harmless; a bearer that matches no grant is refused.
 *
 * @param c - The request carrying the install's bearer.
 * @param pool - Database pool.
 */
export async function revokeCallingConnectionGrant(c: Context, pool: Pool): Promise<void> {
  const token = bearer(c);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'A connected local install is required.');
  const tenant = await resolveCommunityContext(c, pool, {
    allowSuspended: true,
    allowDeletionPending: true,
  });
  const tokenHash = hashSecret(token);
  await transaction(pool, async (client) => {
    const revoked = await client.query<{ id: string; member_id: string }>(
      `UPDATE connection_grants SET revoked_at=now()
       WHERE token_hash=$1 AND community_id=$2 AND revoked_at IS NULL
       RETURNING id,member_id`,
      [tokenHash, tenant.communityId]
    );
    const grant = revoked.rows[0];
    if (grant) {
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [tenant.communityId, grant.member_id, 'grant.revoke', grant.id]
      );
      await notifyLive(client, { k: 'member', c: tenant.communityId, m: grant.member_id });
      return;
    }
    const known = await client.query(
      'SELECT 1 FROM connection_grants WHERE token_hash=$1 AND community_id=$2',
      [tokenHash, tenant.communityId]
    );
    if (!known.rowCount)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This connection is unavailable.');
  });
}

/**
 * Lock the community and the acting member before a member revokes their own grants. Revoking is
 * allowed in every lifecycle a person can still leave from, so only a gone community or an ended
 * membership refuses it.
 */
export async function lockRevocationMember(
  client: PoolClient,
  actor: Awaited<ReturnType<typeof requireMember>>
): Promise<void> {
  const community = await client.query<{ lifecycle: string }>(
    `SELECT lifecycle FROM communities
     WHERE id=$1 AND lifecycle IN ('active','archived','suspended','held','deletion_pending')
     FOR SHARE`,
    [actor.community_id]
  );
  if (!community.rowCount)
    throw new ApiError(409, 'COMMUNITY_UNAVAILABLE', 'This space is unavailable.');
  const member = await client.query(
    'SELECT 1 FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
    [actor.id, actor.community_id]
  );
  if (!member.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
}
