import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityAdminHostLegalHoldRequestSchema,
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
  hostActorRequester,
  recordHostAudit,
  type HostAuthority,
} from '../host/authority.js';
import { ApiError, json, readJson } from '../http.js';

/**
 * Register the host legal hold (spec `community-host-operator-api`, "Legal hold"; ADR
 * `260924-215422`). A legal hold stops every permanent deletion of a community until the host
 * releases it, whatever the lifecycle. Only `communities:legal_hold` sets or releases one.
 *
 * Placing the hold locks the community row `FOR UPDATE`. The deletion worker re-checks the flag
 * under `FOR SHARE` on that row before each blob and before the final row deletion, so once the
 * hold commits the worker removes nothing further. Owners and members are never told.
 */
export function registerHostLegalHoldRoutes(
  app: Hono,
  deps: { pool: Pool; authority: HostAuthority; now: () => Date }
): void {
  const { pool, authority, now } = deps;

  app.put('/host/communities/:id/legal-hold', async (c) => {
    const actor = await authority.require(c, 'communities:legal_hold');
    const body = await readJson(c, CommunityAdminHostLegalHoldRequestSchema);
    const communityId = parseHostCommunityId(c.req.param('id'));
    const community = await transaction(pool, async (client) => {
      const locked = await client.query<{ legal_hold_at: Date | null; lifecycle: string }>(
        'SELECT legal_hold_at,lifecycle FROM communities WHERE id=$1 FOR UPDATE',
        [communityId]
      );
      const at = now();
      await assertHostActor(client, actor, at);
      const row = locked.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (row.legal_hold_at) {
        // Already held: only the reference can change; the start time and holder stand.
        await client.query('UPDATE communities SET legal_hold_reference=$2 WHERE id=$1', [
          communityId,
          body.reference,
        ]);
        await recordHostAudit(client, actor, {
          action: 'community.legal_hold.update',
          communityId,
          priorState: row.lifecycle,
          nextState: row.lifecycle,
          changedFields: ['legal_hold_reference'],
        });
      } else {
        await client.query(
          `UPDATE communities SET legal_hold_at=$2,legal_hold_by_host_actor=$3,
             legal_hold_reference=$4 WHERE id=$1`,
          [communityId, at, hostActorRequester(actor), body.reference]
        );
        await recordHostAudit(client, actor, {
          action: 'community.legal_hold.set',
          communityId,
          priorState: row.lifecycle,
          nextState: row.lifecycle,
          changedFields: [
            'legal_hold_at',
            'legal_hold_by_host_actor',
            ...(body.reference ? ['legal_hold_reference'] : []),
          ],
        });
      }
      return (
        await client.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [communityId])
      ).rows[0];
    });
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community));
  });

  app.delete('/host/communities/:id/legal-hold', async (c) => {
    const actor = await authority.require(c, 'communities:legal_hold');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const community = await transaction(pool, async (client) => {
      const locked = await client.query<{ legal_hold_at: Date | null; lifecycle: string }>(
        'SELECT legal_hold_at,lifecycle FROM communities WHERE id=$1 FOR UPDATE',
        [communityId]
      );
      await assertHostActor(client, actor, now());
      const row = locked.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (!row.legal_hold_at) {
        throw new ApiError(409, 'STATE_CONFLICT', 'This community has no legal hold.');
      }
      await client.query(
        `UPDATE communities SET legal_hold_at=NULL,legal_hold_by_host_actor=NULL,
           legal_hold_reference=NULL WHERE id=$1`,
        [communityId]
      );
      await recordHostAudit(client, actor, {
        action: 'community.legal_hold.release',
        communityId,
        priorState: row.lifecycle,
        nextState: row.lifecycle,
        changedFields: ['legal_hold_at', 'legal_hold_by_host_actor', 'legal_hold_reference'],
      });
      return (
        await client.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [communityId])
      ).rows[0];
    });
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community));
  });
}
