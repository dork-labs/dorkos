import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import type {
  CommunityAdminCreateRequestSchema,
  CommunityAdminCreateResponseSchema,
} from '@dorkos/shared/community-admin-wire';
import { ApiError } from '../http.js';
import { hashSecret, randomToken } from '../security.js';
import type { BlobStore } from '../storage/index.js';
import {
  assertHostActor,
  hostActorRequester,
  recordHostAudit,
  type HostActor,
} from './authority.js';
import {
  createCommunityGated,
  hostProjectionSql,
  projectCommunity,
  type HostCommunityRow,
} from './communities.js';
import { assignShortName, type ShortNameHolds } from './short-names.js';

type CreateRequest = z.infer<typeof CommunityAdminCreateRequestSchema>;

/**
 * A creation under a reserved short name: the name in the request is one a host operator may
 * give out, and `reason` is kept with the record of it.
 */
export interface ReservedNameGrant {
  reason: string;
}

function payloadHash(body: CreateRequest, reserved: ReservedNameGrant | null): string {
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
        ...(body.shortName ? { shortName: body.shortName } : {}),
        // Only on a reserved-name creation, so neither kind of creation can replay the other's
        // receipt: the same key with the other route is an idempotency conflict.
        ...(reserved ? { reservedNameReason: reserved.reason } : {}),
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
    body: CreateRequest;
    reserved: ReservedNameGrant | null;
    tokenHash: string;
    expiresAt: Date;
    reservedNames: ReadonlySet<string>;
    holds: ShortNameHolds;
  }
): Promise<{ row: HostCommunityRow; grantId: string; expiresAt: Date; replayed: boolean }> {
  await client.query('SELECT pg_advisory_xact_lock(77281503)');
  await assertHostActor(client, input.actor, input.now());
  const hash = payloadHash(input.body, input.reserved);
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
  const communityId = community.rows[0].id;
  const grant = await client.query<{ id: string }>(
    `INSERT INTO bootstrap_grants(token_hash,purpose,community_id,expires_at)
     VALUES($1,'owner_claim',$2,$3) RETURNING id`,
    [input.tokenHash, communityId, input.expiresAt]
  );
  if (input.body.limits)
    await client.query(
      `INSERT INTO community_limits(community_id,max_active_members,max_storage_bytes)
       VALUES($1,$2,$3)`,
      [communityId, input.body.limits.maxActiveMembers, input.body.limits.maxStorageBytes]
    );
  if (input.body.shortName)
    await assignShortName(client, {
      communityId,
      shortName: input.body.shortName,
      reservedNames: input.reservedNames,
      holds: input.holds,
      at: input.now(),
      allowReserved: input.reserved !== null,
    });
  if (input.reserved) {
    if (!input.body.shortName) throw new Error('A reserved-name creation needs its short name.');
    await client.query(
      `INSERT INTO reserved_name_grants(short_name,community_id,reason,granted_by_host_actor,created_at)
       VALUES($1,$2,$3,$4,$5)`,
      [
        input.body.shortName,
        communityId,
        input.reserved.reason,
        hostActorRequester(input.actor),
        input.now(),
      ]
    );
  }
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
      communityId,
      grant.rows[0].id,
    ]
  );
  await recordHostAudit(client, input.actor, {
    action: input.reserved ? 'community.create_reserved_name' : 'community.create',
    communityId,
    nextState: 'pending_owner',
    changedFields: [
      'name',
      'description',
      'admission_policy',
      ...(input.body.limits ? ['limits'] : []),
      ...(input.body.shortName ? ['short_name'] : []),
      ...(input.reserved ? ['reserved_name_grant'] : []),
    ],
  });
  const row = await client.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [
    communityId,
  ]);
  return {
    row: row.rows[0],
    grantId: grant.rows[0].id,
    expiresAt: input.expiresAt,
    replayed: false,
  };
}

/**
 * Create one unclaimed community with a single-use owner claim, idempotently on the request's
 * key, through the gate that guards a host's second community. Every host creation goes
 * through here; `reserved` is set only by the reserved-name route, after it has checked that
 * the name is one a host operator may give out.
 */
export async function createHostCommunity(
  deps: {
    pool: Pool;
    blobStore: BlobStore;
    reservedNames: ReadonlySet<string>;
    holds: ShortNameHolds;
    now: () => Date;
  },
  actor: HostActor,
  body: CreateRequest,
  reserved: ReservedNameGrant | null
): Promise<{ status: 200 | 201; response: z.infer<typeof CommunityAdminCreateResponseSchema> }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
  const result = await createCommunityGated(deps.pool, deps.blobStore, (client: PoolClient) =>
    createPendingCommunity(client, {
      actor,
      now: deps.now,
      body,
      reserved,
      tokenHash: hashSecret(token),
      expiresAt,
      reservedNames: deps.reservedNames,
      holds: deps.holds,
    })
  );
  return {
    status: result.replayed ? 200 : 201,
    response: {
      community: projectCommunity(result.row, actor),
      ownerClaimGrantId: result.grantId,
      ownerClaimToken: result.replayed ? null : token,
      expiresAt: result.expiresAt.toISOString(),
      replayed: result.replayed,
    },
  };
}
