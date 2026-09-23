import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityWireConnectionAccessResponseSchema,
  CommunityWireDisconnectAllRequestSchema,
  CommunityWireGrantListResponseSchema,
  CommunityWirePairingApproveRequestSchema,
  CommunityWirePairingApproveResponseSchema,
  CommunityWirePairingPollRequestSchema,
  CommunityWirePairingCancelRequestSchema,
  CommunityWirePairingDeclineRequestSchema,
  CommunityWirePairingDeclineResponseSchema,
  CommunityWirePairingExchangeRequestSchema,
  CommunityWirePairingStartRequestSchema,
  CommunityWirePairingStartResponseSchema,
  CommunityWirePairingStatusResponseSchema,
} from '@dorkos/shared/community-wire';
import {
  CommunityPairingExchangeSecretResponseSchema,
  CommunityPairingPollPrivateResponseSchema,
} from '@dorkos/shared/community-private-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import {
  requireConnectionGrant,
  requireLiveRole,
  requireMember,
  revokeCallingConnectionGrant,
  transaction,
} from '../data.js';
import type { ConfirmPassword } from '../password-confirmation.js';
import { ApiError, json, readJson } from '../http.js';
import { equalSecret, hashSecret, randomToken } from '../security.js';
import { resolveCommunityContext } from '../tenant-context.js';

const uuid = z.uuid();

function challenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function privateCaller(origin: string | undefined) {
  if (origin)
    throw new ApiError(403, 'FORBIDDEN', 'A local install must make this request directly.');
}

function exactArchivedRead(scopes: readonly string[]): boolean {
  return scopes.length === 1 && scopes[0] === 'read';
}

async function pairingScopes(pool: Pool, id: string, communityId: string): Promise<string[]> {
  const result = await pool.query<{ scopes: string[] }>(
    'SELECT scopes FROM connection_pairings WHERE id=$1 AND community_id=$2',
    [id, communityId]
  );
  return result.rows[0]?.scopes ?? [];
}

async function lockPairingCommunity(
  client: PoolClient,
  communityId: string,
  allowArchivedRead: boolean
): Promise<'active' | 'archived'> {
  const result = await client.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
    [communityId]
  );
  const lifecycle = result.rows[0]?.lifecycle;
  if (lifecycle === 'active' || (lifecycle === 'archived' && allowArchivedRead)) return lifecycle;
  if (lifecycle === 'archived')
    throw new ApiError(423, 'COMMUNITY_ARCHIVED', 'Archived communities accept read-only pairing.');
  if (lifecycle === 'suspended')
    throw new ApiError(503, 'COMMUNITY_SUSPENDED', 'This community is suspended.');
  if (lifecycle === 'deletion_pending')
    throw new ApiError(423, 'COMMUNITY_DELETION_PENDING', 'This community is being deleted.');
  throw new ApiError(409, 'COMMUNITY_UNAVAILABLE', 'This community is unavailable.');
}

async function requirePairingMember(
  client: PoolClient,
  actor: Awaited<ReturnType<typeof requireMember>>,
  lifecycle: 'active' | 'archived'
): Promise<void> {
  if (lifecycle === 'active') {
    await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
    return;
  }
  const member = await client.query(
    'SELECT 1 FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
    [actor.id, actor.community_id]
  );
  if (!member.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
}

async function lockRevocationMember(
  client: PoolClient,
  actor: Awaited<ReturnType<typeof requireMember>>
): Promise<void> {
  const community = await client.query<{ lifecycle: string }>(
    `SELECT lifecycle FROM communities
     WHERE id=$1 AND lifecycle IN ('active','archived','suspended','deletion_pending') FOR SHARE`,
    [actor.community_id]
  );
  if (!community.rowCount)
    throw new ApiError(409, 'COMMUNITY_UNAVAILABLE', 'This community is unavailable.');
  const member = await client.query(
    'SELECT 1 FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
    [actor.id, actor.community_id]
  );
  if (!member.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
}

/**
 * Delete pairing requests that expired more than an hour ago and were never exchanged.
 * A pairing lasts ten minutes and nothing else links an abandoned one to a person, so this is
 * what keeps an install name from outliving an erasure.
 */
export async function sweepExpiredPairings(pool: Pool, batchSize = 500): Promise<number> {
  const result = await pool.query(
    `DELETE FROM connection_pairings WHERE id IN (
       SELECT id FROM connection_pairings
       WHERE consumed_at IS NULL AND expires_at<now()-interval '1 hour'
       ORDER BY expires_at,id LIMIT $1
     )`,
    [batchSize]
  );
  return result.rowCount ?? 0;
}

/** Register browser-approved, verifier-bound pairing and revocable personal grants. */
export function registerPairingRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    limitStart,
    confirmPassword,
  }: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    limitStart: (c: Context) => void;
    confirmPassword: ConfirmPassword;
  }
) {
  app.get('/me/connection-access', async (c) => {
    const { member: grant, lifecycle } = await requireConnectionGrant(c, pool, 'read');
    const capabilities = {
      read: true,
      post: grant.scopes.includes('post') && !grant.history_only,
      enrollAgent: grant.scopes.includes('enroll-agent') && !grant.history_only,
      stream: !grant.history_only,
    };
    return json(c, CommunityWireConnectionAccessResponseSchema, {
      access: {
        state: 'verified',
        effective: capabilities,
        lastKnown: {
          lifecycle,
          capabilities,
          verifiedAt: new Date().toISOString(),
        },
      },
    });
  });

  // A local install disconnecting itself: its own bearer revokes exactly its own grant.
  app.delete('/me/connection', async (c) => {
    await revokeCallingConnectionGrant(c, pool);
    return c.body(null, 204);
  });

  app.post('/pairings/start', async (c) => {
    limitStart(c);
    const body = await readJson(c, CommunityWirePairingStartRequestSchema);
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.challenge))
      throw new ApiError(400, 'STATE_CONFLICT', 'The pairing challenge is invalid.');
    const id = randomUUID();
    const expiry = new Date(Date.now() + 600_000);
    const community = await resolveCommunityContext(c, pool);
    const archivedRead =
      community.qualified && community.lifecycle === 'archived' && exactArchivedRead(body.scopes);
    await transaction(pool, async (client) => {
      await lockPairingCommunity(client, community.communityId, archivedRead);
      await client.query(
        'INSERT INTO connection_pairings(id,community_id,verifier_hash,install_name,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          community.communityId,
          body.challenge,
          body.installName,
          [...new Set(body.scopes)],
          expiry,
        ]
      );
    });
    return json(
      c,
      CommunityWirePairingStartResponseSchema,
      {
        pairingId: id,
        approvalUrl: community.qualified
          ? `${config.publicUrl}/c/${community.communityId}/pairing?pairingId=${id}`
          : `${config.publicUrl}/pairing?pairingId=${id}`,
        expiresAt: expiry.toISOString(),
      },
      201
    );
  });

  app.get('/pairings/:id', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const id = uuid.parse(c.req.param('id'));
    const community = await resolveCommunityContext(c, pool);
    const scopes = await pairingScopes(pool, id, actor.community_id);
    const result = await transaction(pool, async (client) => {
      const lifecycle = await lockPairingCommunity(
        client,
        actor.community_id,
        community.qualified && exactArchivedRead(scopes)
      );
      await requirePairingMember(client, actor, lifecycle);
      return client.query<{
        id: string;
        install_name: string;
        scopes: string[];
        expires_at: Date;
        approved_at: Date | null;
        cancelled_at: Date | null;
        consumed_at: Date | null;
      }>(
        'SELECT id,install_name,scopes,expires_at,approved_at,cancelled_at,consumed_at FROM connection_pairings WHERE id=$1 AND community_id=$2',
        [id, actor.community_id]
      );
    });
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Pairing request not found.');
    const status = row.cancelled_at
      ? 'cancelled'
      : row.consumed_at
        ? 'redeemed'
        : row.expires_at.getTime() <= Date.now()
          ? 'expired'
          : row.approved_at
            ? 'approved'
            : 'pending';
    return json(c, CommunityWirePairingStatusResponseSchema, {
      pairingId: row.id,
      status,
      installName: row.install_name,
      scopes: row.scopes as ('read' | 'post' | 'enroll-agent')[],
      expiresAt: row.expires_at.toISOString(),
    });
  });

  app.post('/pairings/approve', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const community = await resolveCommunityContext(c, pool);
    const { pairingId } = await readJson(c, CommunityWirePairingApproveRequestSchema);
    const id = uuid.parse(pairingId);
    const scopes = await pairingScopes(pool, id, actor.community_id);
    await transaction(pool, async (client) => {
      const lifecycle = await lockPairingCommunity(
        client,
        actor.community_id,
        community.qualified && exactArchivedRead(scopes)
      );
      const pair = await client.query<{ member_id: string | null; approved_at: Date | null }>(
        'SELECT member_id,approved_at FROM connection_pairings WHERE id=$1 AND community_id=$2 AND expires_at>now() AND cancelled_at IS NULL AND consumed_at IS NULL FOR UPDATE',
        [id, actor.community_id]
      );
      if (!pair.rows[0])
        throw new ApiError(409, 'STATE_CONFLICT', 'This pairing request is no longer available.');
      await requirePairingMember(client, actor, lifecycle);
      if (pair.rows[0].approved_at) {
        if (pair.rows[0].member_id !== actor.id)
          throw new ApiError(409, 'STATE_CONFLICT', 'This request was approved by another member.');
      } else {
        await client.query(
          'UPDATE connection_pairings SET member_id=$2,community_id=$3,approved_at=now() WHERE id=$1 AND community_id=$3',
          [id, actor.id, actor.community_id]
        );
        await client.query(
          'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
          [actor.community_id, actor.id, 'pairing.approve', id]
        );
      }
    });
    return json(c, CommunityWirePairingApproveResponseSchema, { approved: true });
  });

  app.post('/pairings/decline', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const community = await resolveCommunityContext(c, pool);
    const { pairingId } = await readJson(c, CommunityWirePairingDeclineRequestSchema);
    const id = uuid.parse(pairingId);
    const scopes = await pairingScopes(pool, id, actor.community_id);
    await transaction(pool, async (client) => {
      const lifecycle = await lockPairingCommunity(
        client,
        actor.community_id,
        community.qualified && exactArchivedRead(scopes)
      );
      const pair = await client.query<{ member_id: string | null }>(
        'SELECT member_id FROM connection_pairings WHERE id=$1 AND community_id=$2 AND expires_at>now() AND cancelled_at IS NULL AND consumed_at IS NULL FOR UPDATE',
        [id, actor.community_id]
      );
      if (!pair.rows[0])
        throw new ApiError(409, 'STATE_CONFLICT', 'This pairing request is no longer available.');
      await requirePairingMember(client, actor, lifecycle);
      if (pair.rows[0].member_id && pair.rows[0].member_id !== actor.id)
        throw new ApiError(403, 'FORBIDDEN', 'Another member approved this request.');
      // Record who declined, so erasing that member also removes the install name.
      await client.query(
        'UPDATE connection_pairings SET cancelled_at=now(),member_id=$3 WHERE id=$1 AND community_id=$2',
        [id, actor.community_id, actor.id]
      );
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [actor.community_id, actor.id, 'pairing.decline', id]
      );
    });
    return json(c, CommunityWirePairingDeclineResponseSchema, { cancelled: true });
  });

  app.post('/pairings/poll', async (c) => {
    privateCaller(c.req.header('origin'));
    const community = await resolveCommunityContext(c, pool);
    const { pairingId, verifier } = await readJson(c, CommunityWirePairingPollRequestSchema);
    const id = uuid.parse(pairingId);
    if (!/^[A-Za-z0-9_-]{43}$/.test(verifier))
      throw new ApiError(403, 'FORBIDDEN', 'Invalid pairing verifier.');
    const scopes = await pairingScopes(pool, id, community.communityId);
    const response = await transaction(pool, async (client) => {
      await lockPairingCommunity(
        client,
        community.communityId,
        community.qualified && exactArchivedRead(scopes)
      );
      const result = await client.query<{
        verifier_hash: string;
        approved_at: Date | null;
        polled_at: Date | null;
        cancelled_at: Date | null;
        consumed_at: Date | null;
        expires_at: Date;
      }>(
        'SELECT verifier_hash,approved_at,polled_at,cancelled_at,consumed_at,expires_at FROM connection_pairings WHERE id=$1 AND community_id=$2 FOR UPDATE',
        [id, community.communityId]
      );
      const row = result.rows[0];
      if (!row || !equalSecret(challenge(verifier), row.verifier_hash))
        throw new ApiError(403, 'FORBIDDEN', 'Invalid pairing verifier.');
      if (row.cancelled_at) return { status: 'cancelled' as const };
      if (row.consumed_at) return { status: 'redeemed' as const };
      if (row.expires_at.getTime() <= Date.now()) return { status: 'expired' as const };
      if (!row.approved_at) return { status: 'pending' as const };
      if (row.polled_at) return { status: 'approved' as const };
      const code = randomToken();
      await client.query(
        'UPDATE connection_pairings SET code_hash=$3,polled_at=now() WHERE id=$1 AND community_id=$2',
        [id, community.communityId, hashSecret(code)]
      );
      return { status: 'approved' as const, code };
    });
    const out = json(c, CommunityPairingPollPrivateResponseSchema, response);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  });

  app.post('/pairings/exchange', async (c) => {
    privateCaller(c.req.header('origin'));
    const community = await resolveCommunityContext(c, pool);
    const { pairingId, code, verifier } = await readJson(
      c,
      CommunityWirePairingExchangeRequestSchema
    );
    const id = uuid.parse(pairingId);
    if (!/^[A-Za-z0-9_-]{43}$/.test(verifier))
      throw new ApiError(403, 'FORBIDDEN', 'Invalid pairing verifier.');
    const scopes = await pairingScopes(pool, id, community.communityId);
    const result = await transaction(pool, async (client) => {
      const lifecycle = await lockPairingCommunity(
        client,
        community.communityId,
        community.qualified && exactArchivedRead(scopes)
      );
      const pair = await client.query<{
        verifier_hash: string;
        code_hash: string | null;
        member_id: string | null;
        scopes: string[];
        install_name: string;
        expires_at: Date;
        consumed_at: Date | null;
        cancelled_at: Date | null;
      }>(
        'SELECT verifier_hash,code_hash,member_id,scopes,install_name,expires_at,consumed_at,cancelled_at FROM connection_pairings WHERE id=$1 AND community_id=$2 FOR UPDATE',
        [id, community.communityId]
      );
      const row = pair.rows[0];
      if (!row || !equalSecret(challenge(verifier), row.verifier_hash))
        throw new ApiError(403, 'FORBIDDEN', 'Invalid pairing verifier.');
      if (row.consumed_at || row.cancelled_at || row.expires_at.getTime() <= Date.now())
        throw new ApiError(409, 'STATE_CONFLICT', 'This pairing request is no longer available.');
      if (!row.code_hash || !equalSecret(hashSecret(code), row.code_hash) || !row.member_id)
        throw new ApiError(403, 'FORBIDDEN', 'Invalid pairing code.');
      const member = await client.query(
        'SELECT 1 FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
        [row.member_id, community.communityId]
      );
      if (!member.rowCount)
        throw new ApiError(403, 'FORBIDDEN', 'The approving member is no longer active.');
      const token = randomToken();
      const grant = await client.query<{
        id: string;
        member_id: string;
        scopes: ('read' | 'post' | 'enroll-agent')[];
        history_only: boolean;
        created_at: Date;
      }>(
        `INSERT INTO connection_grants(
           community_id,member_id,token_hash,scopes,install_name,history_only
         ) SELECT community_id,$1,$2,$3,$4,$7 FROM connection_pairings
           WHERE id=$5 AND community_id=$6
         RETURNING id,member_id,scopes,history_only,created_at`,
        [
          row.member_id,
          hashSecret(token),
          row.scopes,
          row.install_name,
          id,
          community.communityId,
          lifecycle === 'archived',
        ]
      );
      await client.query(
        'UPDATE connection_pairings SET consumed_at=now() WHERE id=$1 AND community_id=$2',
        [id, community.communityId]
      );
      return {
        token,
        grant: {
          id: grant.rows[0].id,
          memberId: grant.rows[0].member_id,
          scopes: grant.rows[0].scopes,
          lifecycle,
          capabilities: {
            read: grant.rows[0].scopes.includes('read'),
            post: grant.rows[0].scopes.includes('post'),
            enrollAgent: grant.rows[0].scopes.includes('enroll-agent'),
            stream: grant.rows[0].scopes.includes('read') && !grant.rows[0].history_only,
          },
          installName: row.install_name,
          createdAt: grant.rows[0].created_at.toISOString(),
        },
      };
    });
    const out = json(c, CommunityPairingExchangeSecretResponseSchema, result);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  });

  app.post('/pairings/cancel', async (c) => {
    privateCaller(c.req.header('origin'));
    const community = await resolveCommunityContext(c, pool);
    const { pairingId, verifier } = await readJson(c, CommunityWirePairingCancelRequestSchema);
    const id = uuid.parse(pairingId);
    const scopes = await pairingScopes(pool, id, community.communityId);
    await transaction(pool, async (client) => {
      await lockPairingCommunity(
        client,
        community.communityId,
        community.qualified && exactArchivedRead(scopes)
      );
      const result = await client.query<{ verifier_hash: string }>(
        'SELECT verifier_hash FROM connection_pairings WHERE id=$1 AND community_id=$2 FOR UPDATE',
        [id, community.communityId]
      );
      if (!result.rows[0] || !equalSecret(challenge(verifier), result.rows[0].verifier_hash))
        throw new ApiError(403, 'FORBIDDEN', 'Invalid pairing verifier.');
      await client.query(
        'UPDATE connection_pairings SET cancelled_at=now() WHERE id=$1 AND community_id=$2 AND consumed_at IS NULL AND cancelled_at IS NULL',
        [id, community.communityId]
      );
    });
    return c.body(null, 204);
  });

  app.get('/me/grants', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const result = await transaction(pool, async (client) => {
      const lifecycle = await lockPairingCommunity(client, actor.community_id, true);
      await requirePairingMember(client, actor, lifecycle);
      return client.query<{
        id: string;
        member_id: string;
        scopes: ('read' | 'post' | 'enroll-agent')[];
        install_name: string;
        history_only: boolean;
        lifecycle: 'active' | 'archived';
        created_at: Date;
      }>(
        `SELECT g.id,g.member_id,g.scopes,g.install_name,g.history_only,g.created_at,c.lifecycle
         FROM connection_grants g JOIN communities c ON c.id=g.community_id
         WHERE g.member_id=$1 AND g.community_id=$2 AND g.revoked_at IS NULL
         ORDER BY g.created_at,g.id`,
        [actor.id, actor.community_id]
      );
    });
    return json(c, CommunityWireGrantListResponseSchema, {
      grants: result.rows.map((row) => ({
        id: row.id,
        memberId: row.member_id,
        scopes: row.scopes,
        lifecycle: row.lifecycle,
        capabilities: {
          read: row.scopes.includes('read'),
          post: row.scopes.includes('post'),
          enrollAgent: row.scopes.includes('enroll-agent'),
          stream: row.scopes.includes('read') && !row.history_only,
        },
        installName: row.install_name,
        createdAt: row.created_at.toISOString(),
      })),
    });
  });

  app.delete('/me/grants/:id', async (c) => {
    const actor = await requireMember(c, auth, pool, {
      allowSuspended: true,
      allowDeletionPending: true,
    });
    const id = uuid.parse(c.req.param('id'));
    const result = await transaction(pool, async (client) => {
      const lifecycle = await lockPairingCommunity(client, actor.community_id, true);
      await requirePairingMember(client, actor, lifecycle);
      return client.query(
        `UPDATE connection_grants SET revoked_at=COALESCE(revoked_at,now())
         WHERE id=$1 AND member_id=$2 AND community_id=$3 RETURNING id`,
        [id, actor.id, actor.community_id]
      );
    });
    if (!result.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Grant not found.');
    return c.body(null, 204);
  });

  app.delete('/me/grants', async (c) => {
    const actor = await requireMember(c, auth, pool, {
      allowSuspended: true,
      allowDeletionPending: true,
    });
    const body = await readJson(c, CommunityWireDisconnectAllRequestSchema);
    await confirmPassword(c, actor.user_id, body.password);
    await transaction(pool, async (client) => {
      await lockRevocationMember(client, actor);
      await client.query(
        `UPDATE connection_grants SET revoked_at=COALESCE(revoked_at,now())
         WHERE member_id=$1 AND community_id=$2 AND revoked_at IS NULL`,
        [actor.id, actor.community_id]
      );
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [actor.community_id, actor.id, 'grant.revoke_all', actor.id]
      );
    });
    return c.body(null, 204);
  });
}
