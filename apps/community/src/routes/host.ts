import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityWireHostCommunityCreateRequestSchema,
  CommunityWireHostCommunityCreateResponseSchema,
  CommunityWireHostCommunityLifecycleRequestSchema,
  CommunityWireHostCommunityListResponseSchema,
  CommunityWireHostCommunitySchema,
  CommunityWireOwnerClaimPreflightRequestSchema,
  CommunityWireOwnerClaimPreflightResponseSchema,
  CommunityWireOwnerClaimRequestSchema,
  CommunityWireBootstrapClaimResponseSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import { requireHostOperator, requireSessionUser, transaction } from '../data.js';
import { mintHandle } from '../handles.js';
import { ApiError, json, readJson } from '../http.js';
import { hashSecret, randomToken, readCookie, signValue, verifyValue } from '../security.js';
import type { BlobStore } from '../storage/index.js';
import { withReconciledTenantNamespace } from '../storage/tenant-reconciliation.js';

interface HostCommunityRow {
  id: string;
  name: string;
  description: string | null;
  lifecycle: 'pending_owner' | 'active' | 'suspended';
  created_at: Date;
}

function projectCommunity(row: HostCommunityRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lifecycle: row.lifecycle,
    createdAt: row.created_at.toISOString(),
  };
}

async function assertHostOperator(client: PoolClient, userId: string): Promise<void> {
  const operator = await client.query(
    'SELECT 1 FROM host_operators WHERE user_id=$1 AND revoked_at IS NULL FOR SHARE',
    [userId]
  );
  if (!operator.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Host operator access ended.');
}

async function createPendingCommunity(
  client: PoolClient,
  userId: string,
  name: string,
  tokenHash: string,
  expiresAt: Date
): Promise<HostCommunityRow> {
  await client.query('SELECT pg_advisory_xact_lock(77281503)');
  await assertHostOperator(client, userId);
  const community = await client.query<HostCommunityRow>(
    `INSERT INTO communities(name,lifecycle)
     VALUES($1,'pending_owner')
     RETURNING id,name,description,lifecycle,created_at`,
    [name]
  );
  await client.query(
    `INSERT INTO bootstrap_grants(token_hash,purpose,community_id,expires_at)
     VALUES($1,'owner_claim',$2,$3)`,
    [tokenHash, community.rows[0].id, expiresAt]
  );
  return community.rows[0];
}

/** Register host-only metadata, lifecycle, creation, and pending-owner claim endpoints. */
export function registerHostRoutes(
  app: Hono,
  deps: { pool: Pool; auth: CommunityAuth; config: CommunityConfig; blobStore: BlobStore }
): void {
  const { pool, auth, config, blobStore } = deps;

  app.get('/host/communities', async (c) => {
    await requireHostOperator(c, auth, pool);
    const communities = await pool.query<HostCommunityRow>(
      'SELECT id,name,description,lifecycle,created_at FROM communities ORDER BY created_at,id'
    );
    return json(c, CommunityWireHostCommunityListResponseSchema, {
      communities: communities.rows.map(projectCommunity),
    });
  });

  app.post('/host/communities', async (c) => {
    const operator = await requireHostOperator(c, auth, pool);
    const body = await readJson(c, CommunityWireHostCommunityCreateRequestSchema);
    const token = randomToken();
    const tokenHash = hashSecret(token);
    const expiresAt = new Date(Date.now() + 30 * 60_000);
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

    let community: HostCommunityRow | undefined;
    if (count.rows[0].count === 1) {
      const gated = await withReconciledTenantNamespace(pool, blobStore, async (client) => {
        const current = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM communities'
        );
        if (current.rows[0].count !== 1) {
          throw new ApiError(
            409,
            'STATE_CONFLICT',
            'Community creation changed; retry from current host state.'
          );
        }
        return createPendingCommunity(client, operator.userId, body.name, tokenHash, expiresAt);
      });
      if (!gated.reconciliation.ready || !gated.value) {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'Storage ownership must be reconciled before creating another community.'
        );
      }
      community = gated.value;
    } else {
      community = await transaction(pool, (client) =>
        createPendingCommunity(client, operator.userId, body.name, tokenHash, expiresAt)
      );
    }
    return json(
      c,
      CommunityWireHostCommunityCreateResponseSchema,
      {
        community: projectCommunity(community),
        ownerClaimToken: token,
        expiresAt: expiresAt.toISOString(),
      },
      201
    );
  });

  app.patch('/host/communities/:id/lifecycle', async (c) => {
    const operator = await requireHostOperator(c, auth, pool);
    const body = await readJson(c, CommunityWireHostCommunityLifecycleRequestSchema);
    const communityId = z.uuid().safeParse(c.req.param('id'));
    if (!communityId.success) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
    const community = await transaction(pool, async (client) => {
      await assertHostOperator(client, operator.userId);
      const current = await client.query<HostCommunityRow>(
        'SELECT id,name,description,lifecycle,created_at FROM communities WHERE id=$1 FOR UPDATE',
        [communityId.data]
      );
      if (!current.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (current.rows[0].lifecycle === 'pending_owner') {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'An unclaimed community cannot be suspended or resumed.'
        );
      }
      const updated = await client.query<HostCommunityRow>(
        `UPDATE communities
         SET lifecycle=$2,lifecycle_version=lifecycle_version+1
         WHERE id=$1
         RETURNING id,name,description,lifecycle,created_at`,
        [current.rows[0].id, body.lifecycle]
      );
      return updated.rows[0];
    });
    return json(c, CommunityWireHostCommunitySchema, projectCommunity(community));
  });

  app.post('/owner-claims/preflight', async (c) => {
    const body = await readJson(c, CommunityWireOwnerClaimPreflightRequestSchema);
    const claim = await pool.query<{ community_id: string; expires_at: Date }>(
      `SELECT g.community_id,g.expires_at FROM bootstrap_grants g
       JOIN communities c ON c.id=g.community_id
       WHERE g.token_hash=$1 AND g.purpose='owner_claim' AND g.consumed_at IS NULL
         AND g.expires_at>now() AND c.lifecycle='pending_owner'
         AND NOT EXISTS (
           SELECT 1 FROM members m
           WHERE m.community_id=c.id AND m.role='owner' AND m.active
         )`,
      [hashSecret(body.token)]
    );
    if (!claim.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'The owner claim is unavailable.');
    setCookie(c, 'community_bootstrap', signValue(body.token, config.authSecret), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.publicUrl.startsWith('https:'),
      path: '/',
      maxAge: 30 * 60,
    });
    return json(c, CommunityWireOwnerClaimPreflightResponseSchema, {
      granted: true,
      communityId: claim.rows[0].community_id,
      expiresAt: claim.rows[0].expires_at.toISOString(),
    });
  });

  app.post('/owner-claims/claim', async (c) => {
    await readJson(c, CommunityWireOwnerClaimRequestSchema);
    const user = await requireSessionUser(c, auth);
    const token = verifyValue(
      readCookie(c.req.header('cookie') ?? null, 'community_bootstrap'),
      config.authSecret
    );
    if (!token) throw new ApiError(403, 'FORBIDDEN', 'The owner claim is missing or invalid.');
    const result = await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(77281503)');
      const grant = await client.query<{ id: string; community_id: string }>(
        `SELECT id,community_id FROM bootstrap_grants
         WHERE token_hash=$1 AND purpose='owner_claim' AND community_id IS NOT NULL
           AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        [hashSecret(token)]
      );
      if (!grant.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'The owner claim is unavailable.');
      const community = await client.query<HostCommunityRow>(
        `SELECT id,name,description,lifecycle,created_at FROM communities
         WHERE id=$1 FOR UPDATE`,
        [grant.rows[0].community_id]
      );
      if (community.rows[0]?.lifecycle !== 'pending_owner') {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'Only an unclaimed community accepts this claim.'
        );
      }
      const owner = await client.query(
        "SELECT 1 FROM members WHERE community_id=$1 AND role='owner' AND active",
        [community.rows[0].id]
      );
      if (owner.rowCount)
        throw new ApiError(409, 'STATE_CONFLICT', 'This community already has an owner.');
      const handle = await mintHandle(client, community.rows[0].id, user.name);
      const member = await client.query<{ id: string }>(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,$2,$3,$4,'owner') RETURNING id`,
        [community.rows[0].id, user.id, user.name, handle]
      );
      await client.query(
        'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
        [community.rows[0].id, handle, member.rows[0].id]
      );
      await client.query(
        "UPDATE communities SET lifecycle='active',lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [community.rows[0].id]
      );
      await client.query('UPDATE bootstrap_grants SET consumed_at=now() WHERE id=$1', [
        grant.rows[0].id,
      ]);
      return {
        community: {
          id: community.rows[0].id,
          name: community.rows[0].name,
          description: community.rows[0].description,
          createdAt: community.rows[0].created_at.toISOString(),
        },
        memberId: member.rows[0].id,
      };
    });
    return json(c, CommunityWireBootstrapClaimResponseSchema, result);
  });
}
