import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityAdminHostProjectionSchema,
  CommunityAdminShortNameAvailabilitySchema,
  CommunityAdminShortNamesSchema,
  CommunityAdminShortNameUpdateRequestSchema,
} from '@dorkos/shared/community-admin-wire';
import { CommunityWireShortNameLookupSchema } from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { assertHostActor, recordHostAudit, type HostAuthority } from '../host/authority.js';
import {
  hostProjectionSql,
  parseHostCommunityId,
  projectCommunity,
  type HostCommunityRow,
} from '../host/communities.js';
import {
  assignShortName,
  holdShortNames,
  liftShortNameHold,
  normalizeShortName,
  shortNameAvailability,
  shortNameHoldKey,
  type ShortNameHolds,
} from '../host/short-names.js';
import { ApiError, json, readJson } from '../http.js';

/** The one answer for every name the public lookup will not resolve, whatever the reason. */
const noCommunity = () => new ApiError(404, 'NOT_FOUND', 'No community at this address.');

/**
 * Register short names: the host sets, renames, and releases them, and anyone may resolve a
 * live one to its community. A name is an address, never identity; everything else keeps the
 * community's UUID.
 */
export function registerShortNameRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    config: CommunityConfig;
    authority: HostAuthority;
    now: () => Date;
    /** Count one lookup against the caller; throws once the caller is over its limit. */
    limitLookup: (c: Context) => void;
  }
): void {
  const { pool, config, authority, now, limitLookup } = deps;
  const holds: ShortNameHolds = {
    key: shortNameHoldKey(config.authSecret),
    cooloffDays: config.limits.shortNameCooloffDays,
  };
  const reservedNames = config.reservedShortNames;

  // Exact match only: no listing, prefix search, or metadata. It confirms a live name is in
  // use, which is what a public address is for, and answers every other case identically.
  app.get('/community-names/:name', async (c) => {
    // A name can move to another community after a cool-off, so no answer, found or not, may
    // be reused from a cache.
    c.header('Cache-Control', 'no-store');
    limitLookup(c);
    const name = normalizeShortName(c.req.param('name'));
    if (!name || reservedNames.has(name)) throw noCommunity();
    const found = await pool.query<{ community_id: string; current: string | null }>(
      `SELECT n.community_id,
              (SELECT m.short_name FROM community_short_names m
                WHERE m.community_id=n.community_id AND m.state='current') AS current
       FROM community_short_names n JOIN communities c ON c.id=n.community_id
       WHERE n.short_name=$1 AND c.lifecycle IN ('active','archived','held')`,
      [name]
    );
    const row = found.rows[0];
    if (!row) throw noCommunity();
    // A retired name keeps leading to its community. The answer names the current address to
    // move to, or, when the community has none now, the retired one that was asked for.
    return json(c, CommunityWireShortNameLookupSchema, {
      communityId: row.community_id,
      shortName: row.current ?? name,
    });
  });

  app.get('/host/short-names/:name', async (c) => {
    await authority.require(c, 'communities:read');
    return json(
      c,
      CommunityAdminShortNameAvailabilitySchema,
      await shortNameAvailability(pool, c.req.param('name'), {
        reservedNames,
        holds,
        at: now(),
      })
    );
  });

  app.get('/host/communities/:id/short-names', async (c) => {
    await authority.require(c, 'communities:read');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const community = await pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId]);
    if (!community.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
    const names = await pool.query<{ short_name: string; state: string; retired_at: Date | null }>(
      `SELECT short_name,state,retired_at FROM community_short_names
       WHERE community_id=$1 ORDER BY retired_at DESC NULLS FIRST,short_name`,
      [communityId]
    );
    return json(c, CommunityAdminShortNamesSchema, {
      communityId,
      current: names.rows.find((row) => row.state === 'current')?.short_name ?? null,
      retired: names.rows
        .filter((row) => row.state === 'retired')
        .map((row) => ({ shortName: row.short_name, retiredAt: row.retired_at!.toISOString() })),
    });
  });

  app.put('/host/communities/:id/short-name', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const body = await readJson(c, CommunityAdminShortNameUpdateRequestSchema);
    const community = await transaction(pool, async (client) => {
      const locked = await client.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM communities WHERE id=$1 FOR UPDATE',
        [communityId]
      );
      const at = now();
      await assertHostActor(client, actor, at);
      if (!locked.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (locked.rows[0].lifecycle === 'deletion_pending') {
        throw new ApiError(409, 'STATE_CONFLICT', 'This community is being deleted.');
      }
      const changed = await assignShortName(client, {
        communityId,
        shortName: body.shortName,
        reservedNames,
        holds,
        at,
      });
      if (changed)
        await recordHostAudit(client, actor, {
          action: 'community.short_name',
          communityId,
          changedFields: ['short_name'],
        });
      return (
        await client.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [communityId])
      ).rows[0];
    });
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community, actor));
  });

  // Releasing a retired name is deliberate, for example after a trademark request: until then
  // an old address keeps leading to its community for the community's whole lifetime.
  app.delete('/host/communities/:id/short-names/:name', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const name = normalizeShortName(c.req.param('name'));
    await transaction(pool, async (client) => {
      const locked = await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [
        communityId,
      ]);
      const at = now();
      await assertHostActor(client, actor, at);
      if (!locked.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      const released = name
        ? await client.query(
            `DELETE FROM community_short_names
             WHERE short_name=$1 AND community_id=$2 AND state='retired' RETURNING short_name`,
            [name, communityId]
          )
        : { rowCount: 0 };
      if (!released.rowCount) {
        throw new ApiError(404, 'NOT_FOUND', 'This community has no retired name like that.');
      }
      await holdShortNames(client, [name!], holds, at);
      await recordHostAudit(client, actor, {
        action: 'community.short_name.release',
        communityId,
        changedFields: ['short_name'],
      });
    });
    return c.body(null, 204);
  });

  app.delete('/host/short-name-holds/:name', async (c) => {
    const actor = await authority.require(c, 'communities:write');
    const name = normalizeShortName(c.req.param('name'));
    await transaction(pool, async (client) => {
      await assertHostActor(client, actor, now());
      if (!name || !(await liftShortNameHold(client, name, holds))) {
        throw new ApiError(404, 'NOT_FOUND', 'That web address is not being held.');
      }
      await recordHostAudit(client, actor, {
        action: 'community.short_name.hold_release',
        changedFields: ['short_name_hold'],
      });
    });
    return c.body(null, 204);
  });
}
