import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityAdminClaimMutationRequestSchema,
  CommunityAdminClaimResponseSchema,
  CommunityAdminCreateRequestSchema,
  CommunityAdminCreateResponseSchema,
  CommunityAdminHostLifecycleRequestSchema,
  CommunityAdminHostProjectionSchema,
} from '@dorkos/shared/community-admin-wire';
import {
  CommunityWireBootstrapClaimResponseSchema,
  CommunityWireMembershipListResponseSchema,
  CommunityWireOwnerClaimPreflightRequestSchema,
  CommunityWireOwnerClaimPreflightResponseSchema,
  CommunityWireOwnerClaimRequestSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import { requireSessionUser, transaction } from '../data.js';
import {
  assertHostActor,
  recordHostAudit,
  type HostActor,
  type HostAuthority,
} from '../host-authority.js';
import { mintHandle } from '../handles.js';
import { ApiError, json, readJson } from '../http.js';
import { hashSecret, randomToken, readCookie, signValue, verifyValue } from '../security.js';
import type { BlobStore } from '../storage/index.js';
import { withReconciledTenantNamespace } from '../storage/tenant-reconciliation.js';

interface HostCommunityRow {
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

function projectCommunity(row: HostCommunityRow) {
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

const hostProjectionSql = `SELECT c.id,c.name,c.description,c.lifecycle,c.lifecycle_version,
  c.settings_version,c.created_at,c.suspended_from_state,
  EXISTS(SELECT 1 FROM members m WHERE m.community_id=c.id AND m.role='owner' AND m.active) AS owner_present,
  j.state AS deletion_state
  FROM communities c LEFT JOIN community_deletion_jobs j ON j.community_id=c.id`;

/** The two revoker columns of an owner claim: exactly one names the actor. */
function revokers(actor: HostActor): [string | null, string | null] {
  return actor.kind === 'person' ? [actor.userId, null] : [null, actor.keyId];
}

function payloadHash(body: z.infer<typeof CommunityAdminCreateRequestSchema>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: body.name,
        description: body.description ?? null,
        admissionPolicy: body.admissionPolicy ?? 'invite_only',
      })
    )
    .digest('hex');
}

async function createPendingCommunity(
  client: PoolClient,
  input: {
    actor: HostActor;
    now: Date;
    body: z.infer<typeof CommunityAdminCreateRequestSchema>;
    tokenHash: string;
    expiresAt: Date;
  }
): Promise<{ row: HostCommunityRow; grantId: string; expiresAt: Date; replayed: boolean }> {
  await client.query('SELECT pg_advisory_xact_lock(77281503)');
  await assertHostActor(client, input.actor, input.now);
  const hash = payloadHash(input.body);
  const receipt = await client.query<{
    payload_hash: string;
    community_id: string;
    owner_claim_grant_id: string;
    expires_at: Date;
  }>(
    `SELECT r.payload_hash,r.community_id,r.owner_claim_grant_id,g.expires_at
     FROM community_creation_receipts r
     JOIN bootstrap_grants g ON g.id=r.owner_claim_grant_id
     WHERE r.idempotency_key=$1 FOR UPDATE OF r`,
    [input.body.idempotencyKey]
  );
  if (receipt.rows[0]) {
    if (receipt.rows[0].payload_hash !== hash) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'That creation key has different inputs.');
    }
    const existing = await client.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [
      receipt.rows[0].community_id,
    ]);
    if (!existing.rows[0])
      throw new ApiError(409, 'STATE_CONFLICT', 'Creation receipt is invalid.');
    return {
      row: existing.rows[0],
      grantId: receipt.rows[0].owner_claim_grant_id,
      expiresAt: receipt.rows[0].expires_at,
      replayed: true,
    };
  }
  const community = await client.query<{ id: string }>(
    `INSERT INTO communities(name,description,admission_policy,lifecycle)
     VALUES($1,$2,$3,'pending_owner') RETURNING id`,
    [input.body.name, input.body.description ?? null, input.body.admissionPolicy ?? 'invite_only']
  );
  const grant = await client.query<{ id: string }>(
    `INSERT INTO bootstrap_grants(token_hash,purpose,community_id,expires_at)
     VALUES($1,'owner_claim',$2,$3) RETURNING id`,
    [input.tokenHash, community.rows[0].id, input.expiresAt]
  );
  await client.query(
    `INSERT INTO community_creation_receipts(
       idempotency_key,operator_user_id,operator_api_key_id,payload_hash,community_id,
       owner_claim_grant_id
     ) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      input.body.idempotencyKey,
      input.actor.kind === 'person' ? input.actor.userId : null,
      input.actor.kind === 'api_key' ? input.actor.keyId : null,
      hash,
      community.rows[0].id,
      grant.rows[0].id,
    ]
  );
  await recordHostAudit(client, input.actor, {
    action: 'community.create',
    communityId: community.rows[0].id,
    nextState: 'pending_owner',
    changedFields: ['name', 'description', 'admission_policy'],
  });
  const row = await client.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [
    community.rows[0].id,
  ]);
  return {
    row: row.rows[0],
    grantId: grant.rows[0].id,
    expiresAt: input.expiresAt,
    replayed: false,
  };
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

/** Register host-only metadata, lifecycle, creation, and pending-owner claim endpoints. */
export function registerHostRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    blobStore: BlobStore;
    authority: HostAuthority;
    now: () => Date;
  }
): void {
  const { pool, auth, config, blobStore, authority, now } = deps;
  const hostCommunityId = (value: string | undefined) => {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
    return parsed.data;
  };
  // Set and delete must agree on every attribute, or a browser can keep the original cookie.
  const claimCookieOptions = () => ({
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: config.publicUrl.startsWith('https:'),
    path: '/',
  });

  app.get('/host/communities', async (c) => {
    await authority.require(c, 'communities:read');
    const communities = await pool.query<HostCommunityRow>(
      `${hostProjectionSql} ORDER BY c.created_at,c.id`
    );
    return c.json({ communities: communities.rows.map(projectCommunity) });
  });

  app.get('/host/communities/:id', async (c) => {
    await authority.require(c, 'communities:read');
    const communityId = hostCommunityId(c.req.param('id'));
    const community = await pool.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [
      communityId,
    ]);
    if (!community.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community.rows[0]));
  });

  app.get('/memberships', async (c) => {
    const user = await requireSessionUser(c, auth);
    const memberships = await pool.query<{
      community_id: string;
      name: string;
      description: string | null;
      lifecycle: 'pending_owner' | 'active' | 'archived' | 'suspended' | 'deletion_pending';
      member_id: string;
      display_name: string;
      role: 'owner' | 'admin' | 'member';
    }>(
      `SELECT c.id AS community_id,c.name,c.description,c.lifecycle,
              m.id AS member_id,m.display_name,m.role
       FROM members m JOIN communities c ON c.id=m.community_id
       WHERE m.user_id=$1 AND m.active
       ORDER BY lower(c.name),c.id`,
      [user.id]
    );
    return json(c, CommunityWireMembershipListResponseSchema, {
      memberships: memberships.rows.map((row) => ({
        communityId: row.community_id,
        name: row.name,
        description: row.description,
        lifecycle: row.lifecycle,
        memberId: row.member_id,
        displayName: row.display_name,
        role: row.role,
      })),
    });
  });

  app.post('/host/communities', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const body = await readJson(c, CommunityAdminCreateRequestSchema);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
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
    const create = (client: PoolClient) =>
      createPendingCommunity(client, {
        actor,
        now: now(),
        body,
        tokenHash: hashSecret(token),
        expiresAt,
      });
    let result: Awaited<ReturnType<typeof createPendingCommunity>> | undefined;
    if (count.rows[0].count === 1) {
      const gated = await withReconciledTenantNamespace(pool, blobStore, create);
      if (!gated.reconciliation.ready || !gated.value) {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'Storage ownership must be reconciled before creating another community.'
        );
      }
      result = gated.value;
    } else {
      result = await transaction(pool, create);
    }
    c.header('Cache-Control', 'no-store');
    return json(
      c,
      CommunityAdminCreateResponseSchema,
      {
        community: projectCommunity(result.row),
        ownerClaimGrantId: result.grantId,
        ownerClaimToken: result.replayed ? null : token,
        expiresAt: result.expiresAt.toISOString(),
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201
    );
  });

  app.post('/host/communities/:id/owner-claims/reissue', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    await readJson(c, CommunityAdminClaimMutationRequestSchema);
    const communityId = hostCommunityId(c.req.param('id'));
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
    const grantId = await transaction(pool, async (client) => {
      const community = await client.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM communities WHERE id=$1 FOR UPDATE',
        [communityId]
      );
      await assertHostActor(client, actor, now());
      if (!community.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (community.rows[0].lifecycle !== 'pending_owner') {
        throw new ApiError(409, 'STATE_CONFLICT', 'Only an unclaimed community accepts claims.');
      }
      await client.query(
        `UPDATE bootstrap_grants SET revoked_at=now(),revoked_by=$2,revoked_by_api_key_id=$3
         WHERE community_id=$1 AND purpose='owner_claim' AND consumed_at IS NULL AND revoked_at IS NULL`,
        [communityId, ...revokers(actor)]
      );
      const grant = await client.query<{ id: string }>(
        `INSERT INTO bootstrap_grants(token_hash,purpose,community_id,expires_at)
         VALUES($1,'owner_claim',$2,$3) RETURNING id`,
        [hashSecret(token), communityId, expiresAt]
      );
      await recordHostAudit(client, actor, {
        action: 'owner_claim.reissue',
        communityId,
        changedFields: ['owner_claim'],
      });
      return grant.rows[0].id;
    });
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityAdminClaimResponseSchema, {
      grantId,
      ownerClaimToken: token,
      expiresAt: expiresAt.toISOString(),
    });
  });

  app.post('/host/communities/:id/owner-claims/:grantId/revoke', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    await readJson(c, CommunityAdminClaimMutationRequestSchema);
    const ids = z
      .strictObject({ communityId: z.uuid(), grantId: z.uuid() })
      .safeParse({ communityId: c.req.param('id'), grantId: c.req.param('grantId') });
    if (!ids.success) throw new ApiError(404, 'NOT_FOUND', 'Owner claim not found.');
    await transaction(pool, async (client) => {
      const community = await client.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM communities WHERE id=$1 FOR UPDATE',
        [ids.data.communityId]
      );
      await assertHostActor(client, actor, now());
      if (community.rows[0]?.lifecycle !== 'pending_owner') {
        throw new ApiError(409, 'STATE_CONFLICT', 'Only an unclaimed community has claims.');
      }
      const revoked = await client.query(
        `UPDATE bootstrap_grants SET revoked_at=now(),revoked_by=$3,revoked_by_api_key_id=$4
         WHERE id=$1 AND community_id=$2 AND purpose='owner_claim'
           AND consumed_at IS NULL AND revoked_at IS NULL`,
        [ids.data.grantId, ids.data.communityId, ...revokers(actor)]
      );
      if (!revoked.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Owner claim not found.');
      await recordHostAudit(client, actor, {
        action: 'owner_claim.revoke',
        communityId: ids.data.communityId,
        changedFields: ['owner_claim'],
      });
    });
    return c.body(null, 204);
  });

  app.delete('/host/communities/:id', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const communityId = hostCommunityId(c.req.param('id'));
    await transaction(pool, async (client) => {
      const community = await client.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM communities WHERE id=$1 FOR UPDATE',
        [communityId]
      );
      await assertHostActor(client, actor, now());
      if (!community.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (community.rows[0].lifecycle !== 'pending_owner') {
        throw new ApiError(409, 'STATE_CONFLICT', 'Only an unclaimed community can be abandoned.');
      }
      const unsafe = await client.query(
        `SELECT 1 WHERE
          EXISTS(SELECT 1 FROM members WHERE community_id=$1)
          OR EXISTS(SELECT 1 FROM channels WHERE community_id=$1)
          OR EXISTS(SELECT 1 FROM managed_blobs WHERE community_id=$1)
          OR EXISTS(SELECT 1 FROM bootstrap_grants WHERE community_id=$1 AND revoked_at IS NULL)
        `,
        [communityId]
      );
      if (unsafe.rowCount) {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'Revoke every owner claim and remove unclaimed tenant state first.'
        );
      }
      await client.query('DELETE FROM community_creation_receipts WHERE community_id=$1', [
        communityId,
      ]);
      await client.query('DELETE FROM bootstrap_grants WHERE community_id=$1', [communityId]);
      await client.query('DELETE FROM communities WHERE id=$1', [communityId]);
      await recordHostAudit(client, actor, {
        action: 'community.abandon',
        communityId,
        priorState: 'pending_owner',
      });
    });
    return c.body(null, 204);
  });

  app.patch('/host/communities/:id/lifecycle', async (c) => {
    const actor = await authority.require(c, 'communities:lifecycle');
    const body = await readJson(c, CommunityAdminHostLifecycleRequestSchema);
    const communityId = hostCommunityId(c.req.param('id'));
    const community = await transaction(pool, async (client) => {
      const current = await client.query<HostCommunityRow>(
        `${hostProjectionSql} WHERE c.id=$1 FOR UPDATE OF c`,
        [communityId]
      );
      await assertHostActor(client, actor, now());
      const row = current.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (row.lifecycle_version !== body.lifecycleVersion) {
        throw new ApiError(409, 'STATE_CONFLICT', 'Community lifecycle changed.');
      }
      let next: 'active' | 'archived' | 'suspended';
      if (body.action === 'suspend') {
        if (row.lifecycle !== 'active' && row.lifecycle !== 'archived') {
          throw new ApiError(409, 'STATE_CONFLICT', 'This community cannot be suspended.');
        }
        next = 'suspended';
        await revokeTenantAccess(client, row.id);
        await client.query(
          `UPDATE communities SET lifecycle='suspended',suspended_from_state=$2,
             suspended_at=now(),lifecycle_version=lifecycle_version+1 WHERE id=$1`,
          [row.id, row.lifecycle]
        );
      } else {
        if (row.lifecycle !== 'suspended' || !row.suspended_from_state) {
          throw new ApiError(409, 'STATE_CONFLICT', 'This community is not suspended.');
        }
        next = row.suspended_from_state;
        await client.query(
          `UPDATE communities SET lifecycle=$2,suspended_from_state=NULL,suspended_at=NULL,
             lifecycle_version=lifecycle_version+1 WHERE id=$1`,
          [row.id, next]
        );
      }
      await recordHostAudit(client, actor, {
        action: `community.${body.action}`,
        communityId: row.id,
        priorState: row.lifecycle,
        nextState: next,
        changedFields: ['lifecycle'],
      });
      return (await client.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [row.id]))
        .rows[0];
    });
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community));
  });

  app.post('/owner-claims/preflight', async (c) => {
    const body = await readJson(c, CommunityWireOwnerClaimPreflightRequestSchema);
    const claim = await pool.query<{ community_id: string; expires_at: Date }>(
      `SELECT g.community_id,g.expires_at FROM bootstrap_grants g
       JOIN communities c ON c.id=g.community_id
       WHERE g.token_hash=$1 AND g.purpose='owner_claim' AND g.consumed_at IS NULL
         AND g.revoked_at IS NULL AND g.expires_at>now() AND c.lifecycle='pending_owner'
         AND NOT EXISTS (
           SELECT 1 FROM members m
           WHERE m.community_id=c.id AND m.role='owner' AND m.active
         )`,
      [hashSecret(body.token)]
    );
    if (!claim.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'The owner claim is unavailable.');
    setCookie(c, 'community_bootstrap', signValue(body.token, config.authSecret), {
      ...claimCookieOptions(),
      maxAge: 30 * 60,
    });
    c.header('Cache-Control', 'no-store');
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
    // The claim cookie is single-purpose: drop it once the claim lands or is refused for good,
    // so a stale grant never lingers in the browser. A 401 keeps it for the sign-in retry.
    const dropClaimCookie = () => deleteCookie(c, 'community_bootstrap', claimCookieOptions());
    if (!token) {
      dropClaimCookie();
      throw new ApiError(403, 'FORBIDDEN', 'The owner claim is missing or invalid.');
    }
    const result = await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(77281503)');
      const tokenHash = hashSecret(token);
      // Discover the immutable tenant without taking the grant row lock. Every
      // owner-claim mutation locks community before grant, so claim, reissue,
      // and revoke cannot form a grant↔community lock cycle.
      const candidate = await client.query<{ id: string; community_id: string }>(
        `SELECT id,community_id FROM bootstrap_grants
         WHERE token_hash=$1 AND purpose='owner_claim' AND community_id IS NOT NULL
           AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()`,
        [tokenHash]
      );
      if (!candidate.rows[0])
        throw new ApiError(403, 'FORBIDDEN', 'The owner claim is unavailable.');
      const community = await client.query<HostCommunityRow>(
        `${hostProjectionSql} WHERE c.id=$1 FOR UPDATE OF c`,
        [candidate.rows[0].community_id]
      );
      if (community.rows[0]?.lifecycle !== 'pending_owner') {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'Only an unclaimed community accepts this claim.'
        );
      }
      const grant = await client.query<{ id: string }>(
        `SELECT id FROM bootstrap_grants
         WHERE id=$1 AND community_id=$2 AND token_hash=$3 AND purpose='owner_claim'
           AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`,
        [candidate.rows[0].id, community.rows[0].id, tokenHash]
      );
      if (!grant.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'The owner claim is unavailable.');
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
        `UPDATE communities SET lifecycle='active',activated_at=now(),
           lifecycle_version=lifecycle_version+1 WHERE id=$1`,
        [community.rows[0].id]
      );
      await client.query('UPDATE bootstrap_grants SET consumed_at=now() WHERE id=$1', [
        grant.rows[0].id,
      ]);
      await client.query(
        `INSERT INTO audit_events(
           community_id,actor_member_id,action,prior_state,next_state,changed_fields
         ) VALUES($1,$2,'owner_claim.consume','pending_owner','active',ARRAY['lifecycle','owner'])`,
        [community.rows[0].id, member.rows[0].id]
      );
      return {
        community: {
          id: community.rows[0].id,
          name: community.rows[0].name,
          description: community.rows[0].description,
          createdAt: community.rows[0].created_at.toISOString(),
        },
        memberId: member.rows[0].id,
      };
    }).catch((cause: unknown) => {
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 409))
        dropClaimCookie();
      throw cause;
    });
    dropClaimCookie();
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireBootstrapClaimResponseSchema, result);
  });
}
