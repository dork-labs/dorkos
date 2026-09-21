import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
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
import { lockActiveCommunity, requireLiveRole, requireMember, transaction } from '../data.js';
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

/** Register browser-approved, verifier-bound pairing and revocable personal grants. */
export function registerPairingRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    limitStart,
  }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig; limitStart: (c: Context) => void }
) {
  app.post('/pairings/start', async (c) => {
    limitStart(c);
    const body = await readJson(c, CommunityWirePairingStartRequestSchema);
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.challenge))
      throw new ApiError(400, 'STATE_CONFLICT', 'The pairing challenge is invalid.');
    const id = randomUUID();
    const expiry = new Date(Date.now() + 600_000);
    const community = await resolveCommunityContext(c, pool);
    await transaction(pool, async (client) => {
      await lockActiveCommunity(client, community.communityId);
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
    const result = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
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
    const { pairingId } = await readJson(c, CommunityWirePairingApproveRequestSchema);
    const id = uuid.parse(pairingId);
    await transaction(pool, async (client) => {
      await lockActiveCommunity(client, actor.community_id);
      const pair = await client.query<{ member_id: string | null; approved_at: Date | null }>(
        'SELECT member_id,approved_at FROM connection_pairings WHERE id=$1 AND community_id=$2 AND expires_at>now() AND cancelled_at IS NULL AND consumed_at IS NULL FOR UPDATE',
        [id, actor.community_id]
      );
      if (!pair.rows[0])
        throw new ApiError(409, 'STATE_CONFLICT', 'This pairing request is no longer available.');
      await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
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
    const { pairingId } = await readJson(c, CommunityWirePairingDeclineRequestSchema);
    const id = uuid.parse(pairingId);
    await transaction(pool, async (client) => {
      await lockActiveCommunity(client, actor.community_id);
      const pair = await client.query<{ member_id: string | null }>(
        'SELECT member_id FROM connection_pairings WHERE id=$1 AND community_id=$2 AND expires_at>now() AND cancelled_at IS NULL AND consumed_at IS NULL FOR UPDATE',
        [id, actor.community_id]
      );
      if (!pair.rows[0])
        throw new ApiError(409, 'STATE_CONFLICT', 'This pairing request is no longer available.');
      await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
      if (pair.rows[0].member_id && pair.rows[0].member_id !== actor.id)
        throw new ApiError(403, 'FORBIDDEN', 'Another member approved this request.');
      await client.query(
        'UPDATE connection_pairings SET cancelled_at=now() WHERE id=$1 AND community_id=$2',
        [id, actor.community_id]
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
    const response = await transaction(pool, async (client) => {
      await lockActiveCommunity(client, community.communityId);
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
    const result = await transaction(pool, async (client) => {
      await lockActiveCommunity(client, community.communityId);
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
        created_at: Date;
      }>(
        'INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name) SELECT community_id,$1,$2,$3,$4 FROM connection_pairings WHERE id=$5 AND community_id=$6 RETURNING id,member_id,scopes,created_at',
        [row.member_id, hashSecret(token), row.scopes, row.install_name, id, community.communityId]
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
    await transaction(pool, async (client) => {
      await lockActiveCommunity(client, community.communityId);
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
      await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
      return client.query<{
        id: string;
        member_id: string;
        scopes: ('read' | 'post' | 'enroll-agent')[];
        install_name: string;
        created_at: Date;
      }>(
        'SELECT id,member_id,scopes,install_name,created_at FROM connection_grants WHERE member_id=$1 AND community_id=$2 AND revoked_at IS NULL ORDER BY created_at,id',
        [actor.id, actor.community_id]
      );
    });
    return json(c, CommunityWireGrantListResponseSchema, {
      grants: result.rows.map((row) => ({
        id: row.id,
        memberId: row.member_id,
        scopes: row.scopes,
        installName: row.install_name,
        createdAt: row.created_at.toISOString(),
      })),
    });
  });

  app.delete('/me/grants/:id', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const id = uuid.parse(c.req.param('id'));
    const result = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
      return client.query(
        'UPDATE connection_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND member_id=$2 AND community_id=$3 RETURNING id',
        [id, actor.id, actor.community_id]
      );
    });
    if (!result.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Grant not found.');
    return c.body(null, 204);
  });
}
