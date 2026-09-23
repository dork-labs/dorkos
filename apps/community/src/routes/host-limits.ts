import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  CommunityAdminLimitsSchema,
  CommunityAdminLimitsUpdateRequestSchema,
  CommunityAdminMemberLimitsRequestSchema,
  CommunityAdminMemberLimitsSchema,
  CommunityAdminUsagePageSchema,
  CommunityAdminUsageSchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { parseHostCommunityId } from '../host-communities.js';
import { assertHostActor, recordHostAudit, type HostAuthority } from '../host-authority.js';
import { ApiError, json, readJson } from '../http.js';
import { effectiveAgentLimit, readLimits, readUsage } from '../limits.js';

const UsagePageQuerySchema = z.strictObject({
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

/**
 * Register host-set limits and the host's usage read. Limits shape how much a community may
 * grow; usage returns only the aggregates a host needs to enforce them, never content.
 */
export function registerHostLimitRoutes(
  app: Hono,
  deps: { pool: Pool; config: CommunityConfig; authority: HostAuthority; now: () => Date }
): void {
  const { pool, config, authority, now } = deps;

  app.put('/host/communities/:id/limits', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const body = await readJson(c, CommunityAdminLimitsUpdateRequestSchema);
    const limits = await transaction(pool, async (client) => {
      const community = await client.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
        [communityId]
      );
      await assertHostActor(client, actor, now());
      if (!community.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (community.rows[0].lifecycle === 'deletion_pending') {
        throw new ApiError(409, 'STATE_CONFLICT', 'This community is being deleted.');
      }
      const current = await readLimits(client, communityId, 'FOR UPDATE');
      if (current.limitsVersion !== body.limitsVersion) {
        throw new ApiError(409, 'STATE_CONFLICT', 'Community limits changed. Read them again.');
      }
      // Lowering a limit below current use removes nothing; it refuses only the next growth.
      const updated = await client.query<{ limits_version: number }>(
        `INSERT INTO community_limits(community_id,max_active_members,max_storage_bytes,limits_version)
         VALUES($1,$2,$3,2)
         ON CONFLICT(community_id) DO UPDATE SET max_active_members=EXCLUDED.max_active_members,
           max_storage_bytes=EXCLUDED.max_storage_bytes,
           limits_version=community_limits.limits_version+1,updated_at=now()
         RETURNING limits_version`,
        [communityId, body.maxActiveMembers, body.maxStorageBytes]
      );
      await recordHostAudit(client, actor, {
        action: 'community.limits',
        communityId,
        changedFields: [
          ...(current.maxActiveMembers !== body.maxActiveMembers ? ['max_active_members'] : []),
          ...(current.maxStorageBytes !== body.maxStorageBytes ? ['max_storage_bytes'] : []),
        ],
      });
      return {
        maxActiveMembers: body.maxActiveMembers,
        maxStorageBytes: body.maxStorageBytes,
        limitsVersion: updated.rows[0].limits_version,
      };
    });
    return json(c, CommunityAdminLimitsSchema, limits);
  });

  app.put('/host/communities/:id/members/:memberId/limits', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const memberId = z.uuid().safeParse(c.req.param('memberId'));
    if (!memberId.success) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
    const body = await readJson(c, CommunityAdminMemberLimitsRequestSchema);
    const result = await transaction(pool, async (client) => {
      const community = await client.query('SELECT 1 FROM communities WHERE id=$1 FOR SHARE', [
        communityId,
      ]);
      await assertHostActor(client, actor, now());
      if (!community.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      // The member row's lock orders this against agent enrollment, which locks it too.
      const member = await client.query(
        'SELECT 1 FROM members WHERE id=$1 AND community_id=$2 FOR SHARE',
        [memberId.data, communityId]
      );
      if (!member.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
      if (body.agentsPerMember === null) {
        await client.query(
          'DELETE FROM member_limit_overrides WHERE community_id=$1 AND member_id=$2',
          [communityId, memberId.data]
        );
      } else {
        await client.query(
          `INSERT INTO member_limit_overrides(community_id,member_id,agents_per_member)
           VALUES($1,$2,$3)
           ON CONFLICT(community_id,member_id) DO UPDATE
             SET agents_per_member=EXCLUDED.agents_per_member,updated_at=now()`,
          [communityId, memberId.data, body.agentsPerMember]
        );
      }
      await recordHostAudit(client, actor, {
        action: 'member.limits',
        communityId,
        changedFields: ['agents_per_member'],
      });
      return {
        communityId,
        memberId: memberId.data,
        agentsPerMember: body.agentsPerMember,
        effectiveAgentsPerMember: await effectiveAgentLimit(
          client,
          communityId,
          memberId.data,
          config.limits.agentsPerOwner
        ),
      };
    });
    return json(c, CommunityAdminMemberLimitsSchema, result);
  });

  app.get('/host/communities/:id/usage', async (c) => {
    await authority.require(c, 'communities:read');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const [usage] = await readUsage(pool, { communityId });
    if (!usage) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
    return json(c, CommunityAdminUsageSchema, usage);
  });

  app.get('/host/usage', async (c) => {
    await authority.require(c, 'communities:read');
    const query = UsagePageQuerySchema.parse(c.req.query());
    const rows = await readUsage(pool, { after: query.after ?? null, limit: query.limit + 1 });
    const items = rows.slice(0, query.limit);
    return json(c, CommunityAdminUsagePageSchema, {
      items,
      next: rows.length > query.limit ? items.at(-1)!.communityId : null,
    });
  });
}
