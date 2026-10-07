import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireBanListResponseSchema,
  CommunityWireBanRequestSchema,
  CommunityWireBanResponseSchema,
  type CommunityWireBan,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { z } from 'zod';
import { requireLiveRole, requireMember, transaction, type Member } from '../../data.js';
import { ApiError, json, readJson } from '../../http.js';
import { banEmailKey } from '../../moderation/bans.js';
import { remove } from './members.js';

interface BanRow {
  id: string;
  member_id: string | null;
  display_name: string | null;
  handle: string | null;
  reason: string | null;
  created_at: Date;
}

const BAN_SELECT = `SELECT b.id,b.member_id,m.display_name,m.handle,b.reason,b.created_at
  FROM bans b LEFT JOIN members m ON m.id=b.member_id AND m.community_id=b.community_id`;

function project(row: BanRow): CommunityWireBan {
  return {
    id: row.id,
    memberId: row.member_id,
    displayName: row.display_name ?? 'Former member',
    handle: row.handle,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  };
}

interface TargetRow {
  id: string;
  community_id: string;
  user_id: string | null;
  role: Member['role'];
  active: boolean;
  email: string | null;
}

/**
 * Register bans for owners and admins. A ban ends the membership through the same removal a
 * kick uses, and from then on refuses every way back in (invitation, open join, sign-up, pairing)
 * for that account and for its email, keyed (see `moderation/bans.ts`). An admin can ban members
 * only; the owner can ban admins too; nobody can ban the owner or themselves. Lifting a ban lets
 * the person come back the usual way; it restores nothing.
 */
export function registerBanRoutes(
  app: Hono,
  { pool, auth, config }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig }
): void {
  app.get('/bans', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const rows = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin'], { allowHeld: true });
      return client.query<BanRow>(
        `${BAN_SELECT} WHERE b.community_id=$1 AND b.lifted_at IS NULL
         ORDER BY b.created_at DESC,b.id DESC LIMIT 500`,
        [actor.community_id]
      );
    });
    return json(c, CommunityWireBanListResponseSchema, { bans: rows.rows.map(project) });
  });

  app.post('/members/:id/ban', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireBanRequestSchema);
    const targetId = z.uuid().parse(c.req.param('id'));
    const { ban, created } = await transaction(pool, async (client) => {
      const role = await requireLiveRole(client, actor, ['owner', 'admin']);
      const target = await lockTarget(client, targetId, actor.community_id);
      if (!target) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
      if (target.id === actor.id)
        throw new ApiError(409, 'STATE_CONFLICT', "You can't ban yourself.");
      // A former member's role is history: only a current owner or admin is out of reach.
      if (
        target.active &&
        (target.role === 'owner' || (target.role === 'admin' && role !== 'owner'))
      )
        throw new ApiError(403, 'FORBIDDEN', 'This member cannot be banned by your role.');
      const standing = await client.query<BanRow>(
        `${BAN_SELECT} WHERE b.community_id=$1 AND b.member_id=$2 AND b.lifted_at IS NULL`,
        [actor.community_id, target.id]
      );
      if (standing.rows[0]) return { ban: standing.rows[0], created: false };
      if (!target.user_id)
        throw new ApiError(409, 'STATE_CONFLICT', 'This member’s account is gone.');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bans(community_id,member_id,user_id,email_hash,reason,actor_member_id)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          actor.community_id,
          target.id,
          target.user_id,
          target.email ? banEmailKey(target.email, config.authSecret) : null,
          body.reason ?? null,
          actor.id,
        ]
      );
      // A join attempt this account already started ends here too.
      await client.query('DELETE FROM pending_admissions WHERE community_id=$1 AND account_id=$2', [
        actor.community_id,
        target.user_id,
      ]);
      if (target.active) await remove(client, target, actor.id, 'member.ban');
      else
        await client.query(
          `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id)
           VALUES($1,$2,'member.ban',$3)`,
          [actor.community_id, actor.id, target.id]
        );
      const row = await client.query<BanRow>(`${BAN_SELECT} WHERE b.id=$1`, [inserted.rows[0].id]);
      return { ban: row.rows[0], created: true };
    });
    return json(c, CommunityWireBanResponseSchema, { ban: project(ban) }, created ? 201 : 200);
  });

  app.delete('/bans/:id', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const banId = z.uuid().parse(c.req.param('id'));
    await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin']);
      const lifted = await client.query<{ member_id: string | null }>(
        `UPDATE bans SET lifted_at=now(),lifted_by_member_id=$3
         WHERE id=$1 AND community_id=$2 AND lifted_at IS NULL RETURNING member_id`,
        [banId, actor.community_id, actor.id]
      );
      if (!lifted.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Ban not found.');
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id)
         VALUES($1,$2,'member.unban',$3)`,
        [actor.community_id, actor.id, lifted.rows[0].member_id ?? banId]
      );
    });
    return c.body(null, 204);
  });
}

/** Lock the member to ban, current or former, with the email of the account behind it. */
async function lockTarget(
  client: PoolClient,
  id: string,
  communityId: string
): Promise<TargetRow | undefined> {
  const result = await client.query<TargetRow>(
    `SELECT m.id,m.community_id,m.user_id,m.role,m.active,u.email
     FROM members m LEFT JOIN "user" u ON u.id=m.user_id
     WHERE m.id=$1 AND m.community_id=$2 AND m.erased_at IS NULL FOR UPDATE OF m`,
    [id, communityId]
  );
  return result.rows[0];
}
