import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import {
  CommunityAdminCreateRequestSchema,
  CommunityAdminCreateResponseSchema,
  CommunityAdminHostProjectionSchema,
} from '@dorkos/shared/community-admin-wire';
import { transaction } from '../data.js';
import {
  hostProjectionSql,
  parseHostCommunityId,
  projectCommunity,
  type HostCommunityRow,
} from '../host/communities.js';
import {
  assertHostActor,
  recordHostAudit,
  type HostActor,
  type HostAuthority,
} from '../host/authority.js';
import { ApiError, json, readJson } from '../http.js';
import { hashSecret, randomToken } from '../security.js';
import type { BlobStore } from '../storage/index.js';
import { withReconciledTenantNamespace } from '../storage/tenant-reconciliation.js';

function payloadHash(body: z.infer<typeof CommunityAdminCreateRequestSchema>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: body.name,
        description: body.description ?? null,
        admissionPolicy: body.admissionPolicy ?? 'invite_only',
        // Only when sent, so receipts written before limits existed still replay.
        ...(body.limits
          ? {
              limits: {
                maxActiveMembers: body.limits.maxActiveMembers,
                maxStorageBytes: body.limits.maxStorageBytes,
              },
            }
          : {}),
      })
    )
    .digest('hex');
}

async function createPendingCommunity(
  client: PoolClient,
  input: {
    actor: HostActor;
    /** Read after the creation lock, so a key that expires while this waits is refused. */
    now: () => Date;
    body: z.infer<typeof CommunityAdminCreateRequestSchema>;
    tokenHash: string;
    expiresAt: Date;
  }
): Promise<{ row: HostCommunityRow; grantId: string; expiresAt: Date; replayed: boolean }> {
  await client.query('SELECT pg_advisory_xact_lock(77281503)');
  await assertHostActor(client, input.actor, input.now());
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
  if (input.body.limits)
    await client.query(
      `INSERT INTO community_limits(community_id,max_active_members,max_storage_bytes)
       VALUES($1,$2,$3)`,
      [community.rows[0].id, input.body.limits.maxActiveMembers, input.body.limits.maxStorageBytes]
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
    changedFields: [
      'name',
      'description',
      'admission_policy',
      ...(input.body.limits ? ['limits'] : []),
    ],
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

/** Register the host plane's community records: list, read, create, abandon, and lifecycle. */
export function registerHostRoutes(
  app: Hono,
  deps: { pool: Pool; blobStore: BlobStore; authority: HostAuthority; now: () => Date }
): void {
  const { pool, blobStore, authority, now } = deps;

  app.get('/host/communities', async (c) => {
    await authority.require(c, 'communities:read');
    const communities = await pool.query<HostCommunityRow>(
      `${hostProjectionSql} ORDER BY c.created_at,c.id`
    );
    return c.json({ communities: communities.rows.map(projectCommunity) });
  });

  app.get('/host/communities/:id', async (c) => {
    await authority.require(c, 'communities:read');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const community = await pool.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [
      communityId,
    ]);
    if (!community.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community.rows[0]));
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
        now,
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

  app.delete('/host/communities/:id', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const communityId = parseHostCommunityId(c.req.param('id'));
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
      // Host-set limits are metadata the host may give an unclaimed community; they go with it.
      await client.query('DELETE FROM community_limits WHERE community_id=$1', [communityId]);
      await client.query('DELETE FROM communities WHERE id=$1', [communityId]);
      await recordHostAudit(client, actor, {
        action: 'community.abandon',
        communityId,
        priorState: 'pending_owner',
      });
    });
    return c.body(null, 204);
  });
}
