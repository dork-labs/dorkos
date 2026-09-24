import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityAdminHostDeletionRequestSchema,
  CommunityAdminHostLifecycleRequestSchema,
  CommunityAdminHostProjectionSchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { prepareCommunityDeletionInventory } from '../deletion-worker.js';
import {
  hostProjectionSql,
  legalHoldActive,
  parseHostCommunityId,
  projectCommunity,
  revokeTenantAccess,
  type HostCommunityRow,
} from '../host/communities.js';
import {
  assertHostActor,
  hostActorRequester,
  recordHostAudit,
  type HostAuthority,
} from '../host/authority.js';
import { ApiError, json, readJson } from '../http.js';
import type { BlobStore } from '../storage/index.js';

const DAY_MS = 24 * 60 * 60_000;

async function lockHostCommunity(client: PoolClient, communityId: string) {
  const current = await client.query<HostCommunityRow>(
    `${hostProjectionSql} WHERE c.id=$1 FOR UPDATE OF c`,
    [communityId]
  );
  return current.rows[0];
}

async function readHostCommunity(client: PoolClient, communityId: string) {
  return (await client.query<HostCommunityRow>(`${hostProjectionSql} WHERE c.id=$1`, [communityId]))
    .rows[0];
}

/**
 * Register host lifecycle transitions and host-started deletion.
 *
 * Suspension blocks every member request and revokes every credential. A hold is gentler: it
 * revokes nothing, members and their agents can read, the owner can still export and ask to
 * delete, and nothing grows. A host may delete a community only from a
 * hold, only after the published notice date, and may cancel only the deletion it started.
 */
export function registerHostLifecycleRoutes(
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

  /** A notice date must give members at least the configured number of days from now. */
  const assertNotice = (notice: string | null, at: Date): Date | null => {
    if (notice === null) return null;
    const date = new Date(notice);
    if (date.getTime() < at.getTime() + config.limits.hostDeletionNoticeDays * DAY_MS) {
      throw new ApiError(
        409,
        'STATE_CONFLICT',
        `A deletion notice must be at least ${config.limits.hostDeletionNoticeDays} days away.`
      );
    }
    return date;
  };

  app.patch('/host/communities/:id/lifecycle', async (c) => {
    const actor = await authority.require(c, 'communities:lifecycle');
    const body = await readJson(c, CommunityAdminHostLifecycleRequestSchema);
    const communityId = parseHostCommunityId(c.req.param('id'));
    const community = await transaction(pool, async (client) => {
      const row = await lockHostCommunity(client, communityId);
      const at = now();
      await assertHostActor(client, actor, at);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (row.lifecycle_version !== body.lifecycleVersion) {
        throw new ApiError(409, 'STATE_CONFLICT', 'Community lifecycle changed.');
      }
      let next: string;
      const changedFields = ['lifecycle'];
      if (body.action === 'suspend') {
        if (
          row.lifecycle !== 'active' &&
          row.lifecycle !== 'archived' &&
          row.lifecycle !== 'held'
        ) {
          throw new ApiError(409, 'STATE_CONFLICT', 'This community cannot be suspended.');
        }
        next = 'suspended';
        // A suspension blocks the owner's export, so it also withdraws any deletion notice: the
        // notice's days only count while the owner can take their data out. After resuming, the
        // host publishes a new notice, and members get the full notice again.
        if (row.deletion_notice_at) changedFields.push('deletion_notice_at');
        await revokeTenantAccess(client, row.id);
        await client.query(
          `UPDATE communities SET lifecycle='suspended',suspended_from_state=$2,
             suspended_at=now(),deletion_notice_at=NULL,lifecycle_version=lifecycle_version+1
           WHERE id=$1`,
          [row.id, row.lifecycle]
        );
      } else if (body.action === 'resume') {
        if (row.lifecycle !== 'suspended' || !row.suspended_from_state) {
          throw new ApiError(409, 'STATE_CONFLICT', 'This community is not suspended.');
        }
        next = row.suspended_from_state;
        await client.query(
          `UPDATE communities SET lifecycle=$2,suspended_from_state=NULL,suspended_at=NULL,
             lifecycle_version=lifecycle_version+1 WHERE id=$1`,
          [row.id, next]
        );
      } else if (body.action === 'hold' && row.lifecycle === 'suspended') {
        // Hold a suspended community in one step (DOR-2299). Resuming and then holding in two
        // calls left it live if the second failed; here the only states anyone can observe are
        // suspended before and held after. Suspension already revoked every credential, and a
        // hold revives none. From a suspension of a hold, the kept held_from_state and held_at
        // stand; the suspension withdrew the old notice, so a new one may be published now.
        if (!row.suspended_from_state) {
          throw new ApiError(409, 'STATE_CONFLICT', 'This community cannot be held.');
        }
        const notice = assertNotice(body.deletionNoticeAt, at);
        next = 'held';
        changedFields.push('suspended_from_state');
        if (notice) changedFields.push('deletion_notice_at');
        await client.query(
          `UPDATE communities SET lifecycle='held',
             held_from_state=CASE WHEN suspended_from_state='held' THEN held_from_state
                                  ELSE suspended_from_state END,
             held_at=CASE WHEN suspended_from_state='held' THEN held_at ELSE $2 END,
             suspended_from_state=NULL,suspended_at=NULL,deletion_notice_at=$3,
             lifecycle_version=lifecycle_version+1 WHERE id=$1`,
          [row.id, at, notice]
        );
      } else if (body.action === 'hold') {
        if (row.lifecycle !== 'active' && row.lifecycle !== 'archived') {
          throw new ApiError(
            409,
            'STATE_CONFLICT',
            'Only an active, archived, or suspended community can be held.'
          );
        }
        const notice = assertNotice(body.deletionNoticeAt, at);
        next = 'held';
        if (notice) changedFields.push('deletion_notice_at');
        // A hold refuses growth by lifecycle alone: every write, join, enrollment, and stream
        // checks it. Credentials, agents, and invitations stay, so the community resumes on
        // release with nobody reconnecting. Suspension is the tool that cuts access.
        await client.query(
          `UPDATE communities SET lifecycle='held',held_from_state=lifecycle,held_at=$2,
             deletion_notice_at=$3,lifecycle_version=lifecycle_version+1 WHERE id=$1`,
          [row.id, at, notice]
        );
      } else if (body.action === 'release') {
        if (row.lifecycle !== 'held' || !row.held_from_state) {
          throw new ApiError(409, 'STATE_CONFLICT', 'This community is not held.');
        }
        next = row.held_from_state;
        await client.query(
          `UPDATE communities SET lifecycle=held_from_state,
             archived_at=CASE WHEN held_from_state='archived' THEN COALESCE(archived_at,now()) END,
             held_from_state=NULL,held_at=NULL,deletion_notice_at=NULL,
             lifecycle_version=lifecycle_version+1 WHERE id=$1`,
          [row.id]
        );
      } else {
        if (row.lifecycle !== 'held') {
          throw new ApiError(409, 'STATE_CONFLICT', 'Only a held community has a deletion notice.');
        }
        // Every publication must itself give the minimum notice from now: a date can be moved
        // later or cleared, and moved sooner only while it still stays that far away.
        const notice = assertNotice(body.deletionNoticeAt, at);
        next = 'held';
        changedFields.splice(0, 1, 'deletion_notice_at');
        await client.query(
          `UPDATE communities SET deletion_notice_at=$2,lifecycle_version=lifecycle_version+1
           WHERE id=$1`,
          [row.id, notice]
        );
      }
      await recordHostAudit(client, actor, {
        action: `community.${body.action}`,
        communityId: row.id,
        priorState: row.lifecycle,
        nextState: next,
        changedFields,
      });
      return readHostCommunity(client, row.id);
    });
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community));
  });

  app.post('/host/communities/:id/deletion', async (c) => {
    const actor = await authority.require(c, 'communities:lifecycle');
    const body = await readJson(c, CommunityAdminHostDeletionRequestSchema);
    const communityId = parseHostCommunityId(c.req.param('id'));
    // Every gate is checked here and again under the lock. Checking first keeps a refused
    // request from building the deletion inventory at all.
    const gate = (row: HostCommunityRow | undefined, at: Date): HostCommunityRow => {
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      if (row.legal_hold_at) throw legalHoldActive();
      if (row.lifecycle_version !== body.lifecycleVersion) {
        throw new ApiError(409, 'STATE_CONFLICT', 'Community lifecycle changed.');
      }
      if (row.lifecycle !== 'held') {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'Only a held community can be deleted by its host.'
        );
      }
      if (!row.deletion_notice_at || row.deletion_notice_at.getTime() > at.getTime()) {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'The deletion notice date has not passed. Members can still export until then.'
        );
      }
      if (body.confirmIdSuffix !== row.id.slice(-8)) {
        throw new ApiError(409, 'STATE_CONFLICT', 'Deletion confirmation did not match.');
      }
      return row;
    };
    await transaction(pool, async (client) =>
      gate(await readHostCommunity(client, communityId), now())
    );
    if (!(await prepareCommunityDeletionInventory(pool, blobStore, communityId))) {
      throw new ApiError(
        409,
        'STATE_CONFLICT',
        'Storage ownership must be reconciled before deleting this community.'
      );
    }
    const community = await transaction(pool, async (client) => {
      const at = now();
      const locked = await lockHostCommunity(client, communityId);
      await assertHostActor(client, actor, at);
      const row = gate(locked, at);
      await revokeTenantAccess(client, row.id);
      const deleteAfter = new Date(at.getTime() + 7 * DAY_MS);
      const requester = hostActorRequester(actor);
      const updated = await client.query<{ lifecycle_version: number }>(
        `UPDATE communities SET lifecycle='deletion_pending',
           deletion_from_state='held',deletion_from_prior_state=held_from_state,
           delete_requested_at=$2,delete_after=$3,delete_requested_by_host_actor=$4,
           lifecycle_version=lifecycle_version+1
         WHERE id=$1 RETURNING lifecycle_version`,
        [row.id, at, deleteAfter, requester]
      );
      await client.query(
        `INSERT INTO community_deletion_jobs(
           community_id,requested_by_host_actor,lifecycle_version,delete_after,next_attempt_at
         ) VALUES($1,$2,$3,$4,$4)`,
        [row.id, requester, updated.rows[0].lifecycle_version, deleteAfter]
      );
      await recordHostAudit(client, actor, {
        action: 'community.delete.request',
        communityId: row.id,
        priorState: 'held',
        nextState: 'deletion_pending',
        changedFields: ['lifecycle', 'delete_after'],
      });
      return readHostCommunity(client, row.id);
    });
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community));
  });

  app.delete('/host/communities/:id/deletion', async (c) => {
    const actor = await authority.require(c, 'communities:lifecycle');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const community = await transaction(pool, async (client) => {
      const row = await lockHostCommunity(client, communityId);
      const at = now();
      await assertHostActor(client, actor, at);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
      // The host cancels only its own deletion, and only before the worker starts; an owner's
      // deletion is the owner's to cancel.
      const pending = await client.query<{ delete_after: Date; state: string }>(
        `SELECT c.delete_after,j.state FROM communities c
         JOIN community_deletion_jobs j ON j.community_id=c.id
         WHERE c.id=$1 AND c.lifecycle='deletion_pending'
           AND c.delete_requested_by_host_actor IS NOT NULL`,
        [row.id]
      );
      const job = pending.rows[0];
      if (!job || job.state !== 'waiting' || job.delete_after.getTime() <= at.getTime()) {
        throw new ApiError(409, 'STATE_CONFLICT', 'This deletion can no longer be cancelled.');
      }
      await client.query(
        `UPDATE communities SET lifecycle='held',delete_requested_at=NULL,delete_after=NULL,
           delete_requested_by_host_actor=NULL,lifecycle_version=lifecycle_version+1
         WHERE id=$1`,
        [row.id]
      );
      await client.query('DELETE FROM community_deletion_jobs WHERE community_id=$1', [row.id]);
      await recordHostAudit(client, actor, {
        action: 'community.delete.cancel',
        communityId: row.id,
        priorState: 'deletion_pending',
        nextState: 'held',
        changedFields: ['lifecycle', 'delete_after'],
      });
      return readHostCommunity(client, row.id);
    });
    return json(c, CommunityAdminHostProjectionSchema, projectCommunity(community));
  });
}
