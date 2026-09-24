import type { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityAdminClaimMutationRequestSchema,
  CommunityAdminClaimResponseSchema,
} from '@dorkos/shared/community-admin-wire';
import {
  CommunityWireBootstrapClaimResponseSchema,
  CommunityWireOwnerClaimPreflightRequestSchema,
  CommunityWireOwnerClaimPreflightResponseSchema,
  CommunityWireOwnerClaimRequestSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import { requireSessionUser, transaction } from '../data.js';
import { mintHandle } from '../handles.js';
import { accountErasureOpen } from '../erasure/guards.js';
import {
  hostProjectionSql,
  parseHostCommunityId,
  type HostCommunityRow,
} from '../host/communities.js';
import {
  assertHostActor,
  recordHostAudit,
  type HostActor,
  type HostAuthority,
} from '../host/authority.js';
import { ApiError, json, readJson } from '../http.js';
import { hashSecret, randomToken, readCookie, signValue, verifyValue } from '../security.js';

/**
 * Refuse an owner claim for a community whose import has not finished: until it is `ready`,
 * the community's history is still being restored, and nobody may own it yet.
 */
async function assertImportReady(client: PoolClient, communityId: string): Promise<void> {
  const unfinished = await client.query(
    "SELECT 1 FROM community_imports WHERE community_id=$1 AND state<>'ready' FOR SHARE",
    [communityId]
  );
  if (unfinished.rowCount)
    throw new ApiError(409, 'STATE_CONFLICT', 'This community is still being imported.');
}

/** The two revoker columns of an owner claim: exactly one names the actor. */
function revokers(actor: HostActor): [string | null, string | null] {
  return actor.kind === 'person' ? [actor.userId, null] : [null, actor.keyId];
}

/**
 * Register owner claims for unclaimed communities: the host reissues or revokes them, and the
 * intended owner previews and redeems one with their own signed-in account.
 */
export function registerOwnerClaimRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    authority: HostAuthority;
    now: () => Date;
  }
): void {
  const { pool, auth, config, authority, now } = deps;
  // Set and delete must agree on every attribute, or a browser can keep the original cookie.
  const claimCookieOptions = () => ({
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: config.publicUrl.startsWith('https:'),
    path: '/',
  });

  app.post('/host/communities/:id/owner-claims/reissue', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    await readJson(c, CommunityAdminClaimMutationRequestSchema);
    const communityId = parseHostCommunityId(c.req.param('id'));
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
      await assertImportReady(client, communityId);
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
      await assertImportReady(client, community.rows[0].id);
      const owner = await client.query(
        "SELECT 1 FROM members WHERE community_id=$1 AND role='owner' AND active",
        [community.rows[0].id]
      );
      if (owner.rowCount)
        throw new ApiError(409, 'STATE_CONFLICT', 'This community already has an owner.');
      // The account row lock orders this check against a new account-erasure request.
      await client.query('SELECT 1 FROM "user" WHERE id=$1 FOR SHARE', [user.id]);
      if (await accountErasureOpen(client, user.id))
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'This account is being deleted, so it cannot claim a community.'
        );
      // An imported community's owner adopts the row of the owner who made the export, so
      // their own history stays theirs; every other past author stays historical.
      const adopted = await client.query<{ id: string }>(
        `UPDATE members m SET user_id=$2,active=true,removed_at=NULL
         FROM community_imports i
         WHERE i.community_id=$1 AND i.state='ready' AND m.id=i.adopt_member_id
           AND m.community_id=$1 AND m.user_id IS NULL AND m.origin='imported'
         RETURNING m.id`,
        [community.rows[0].id, user.id]
      );
      const member = adopted.rows[0]
        ? adopted
        : await (async () => {
            const handle = await mintHandle(client, community.rows[0].id, user.name);
            const inserted = await client.query<{ id: string }>(
              `INSERT INTO members(community_id,user_id,display_name,handle,role)
               VALUES($1,$2,$3,$4,'owner') RETURNING id`,
              [community.rows[0].id, user.id, user.name, handle]
            );
            await client.query(
              'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
              [community.rows[0].id, handle, inserted.rows[0].id]
            );
            return inserted;
          })();
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
