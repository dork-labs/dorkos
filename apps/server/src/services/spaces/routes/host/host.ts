import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityAdminCreateRequestSchema,
  CommunityAdminCreateResponseSchema,
  CommunityAdminHostCapabilitiesSchema,
  CommunityAdminHostProjectionSchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityConfig } from '../../config.js';
import { transaction } from '../../data.js';
import {
  releaseCommunityShortNames,
  shortNameHoldKey,
  type ShortNameHolds,
} from '../../host/short-names.js';
import {
  hostProjectionSql,
  legalHoldActive,
  parseHostCommunityId,
  projectCommunity,
  type HostCommunityRow,
} from '../../host/communities.js';
import { assertHostActor, recordHostAudit, type HostAuthority } from '../../host/authority.js';
import { createHostCommunity } from '../../host/create-community.js';
import { ApiError, json, readJson } from '../../http.js';
import type { BlobStore } from '../../storage/index.js';
import { registerReservedNameCreation } from './host-reserved-names.js';

/**
 * Register the host plane's community records (list, read, create, abandon, and lifecycle) and
 * the host's capabilities.
 */
export function registerHostRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    config: CommunityConfig;
    blobStore: BlobStore;
    authority: HostAuthority;
    now: () => Date;
  }
): void {
  const { pool, config, blobStore, authority, now } = deps;
  const holds: ShortNameHolds = {
    key: shortNameHoldKey(config.authSecret),
    cooloffDays: config.limits.shortNameCooloffDays,
  };

  // Whether this host can send mail and has single sign-on. Booleans only: never the mail
  // server, the sender, the issuer, or any credential.
  app.get('/host/capabilities', async (c) => {
    await authority.require(c, 'communities:read');
    return json(c, CommunityAdminHostCapabilitiesSchema, {
      mail: config.mail !== null,
      oidc: config.oidc !== null,
    });
  });

  app.get('/host/communities', async (c) => {
    const actor = await authority.require(c, 'communities:read');
    const communities = await pool.query<HostCommunityRow>(
      `${hostProjectionSql} ORDER BY c.created_at,c.id`
    );
    return c.json({
      communities: communities.rows.map((row) => projectCommunity(row, actor)),
      // The least notice this host allows before deleting a held community, for its own page.
      deletionNoticeDays: config.limits.hostDeletionNoticeDays,
    });
  });

  app.get('/host/communities/:id', async (c) => {
    const actor = await authority.require(c, 'communities:read');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const community = await pool.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [
      communityId,
    ]);
    if (!community.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Space not found.');
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community.rows[0], actor));
  });

  app.post('/host/communities', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const body = await readJson(c, CommunityAdminCreateRequestSchema);
    const created = await createHostCommunity(
      { pool, blobStore, reservedNames: config.reservedShortNames, holds, now },
      actor,
      body,
      null
    );
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityAdminCreateResponseSchema, created.response, created.status);
  });

  registerReservedNameCreation(app, { pool, config, blobStore, authority, now, holds });

  app.delete('/host/communities/:id', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const outcome = await transaction(pool, async (client) => {
      const community = await client.query<{ lifecycle: string; legal_hold_at: Date | null }>(
        'SELECT lifecycle,legal_hold_at FROM communities WHERE id=$1 FOR UPDATE',
        [communityId]
      );
      await assertHostActor(client, actor, now());
      if (!community.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Space not found.');
      if (community.rows[0].legal_hold_at) throw legalHoldActive();
      if (community.rows[0].lifecycle !== 'pending_owner') {
        throw new ApiError(409, 'STATE_CONFLICT', 'Only an unclaimed space can be abandoned.');
      }
      const imported = await client.query<{ id: string; state: string }>(
        'SELECT id,state FROM community_imports WHERE community_id=$1 FOR UPDATE',
        [communityId]
      );
      if (imported.rows[0]?.state === 'ready') {
        // Nobody has claimed it, so nobody has ever read it. It holds content, so its rows and
        // files are removed in the background, with no grace period.
        await client.query(
          `UPDATE community_imports SET state='cancelled',settled_at=NULL,next_attempt_at=now(),
             updated_at=now() WHERE id=$1`,
          [imported.rows[0].id]
        );
        await client.query(
          `UPDATE bootstrap_grants SET revoked_at=now(),revoked_by=$2,revoked_by_api_key_id=$3
           WHERE community_id=$1 AND revoked_at IS NULL AND consumed_at IS NULL`,
          [
            communityId,
            actor.kind === 'person' ? actor.userId : null,
            actor.kind === 'api_key' ? actor.keyId : null,
          ]
        );
        await recordHostAudit(client, actor, {
          action: 'community.abandon',
          communityId,
          priorState: 'pending_owner',
        });
        return 'removing' as const;
      }
      if (imported.rowCount) {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'This space is being imported. Cancel its import instead.'
        );
      }
      const unsafe = await client.query(
        // member-kind: whole-space
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
      // Nobody ever reached a never-claimed community by its name, so the name is free at once.
      await releaseCommunityShortNames(client, communityId, { hold: false });
      await client.query('DELETE FROM communities WHERE id=$1', [communityId]);
      await recordHostAudit(client, actor, {
        action: 'community.abandon',
        communityId,
        priorState: 'pending_owner',
      });
      return 'removed' as const;
    });
    return c.body(null, outcome === 'removing' ? 202 : 204);
  });
}
