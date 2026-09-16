import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireMemberDirectoryPageSchema,
  CommunityWireMemberDirectoryQuerySchema,
  CommunityWireMemberResponseSchema,
  CommunityWireOwnerTransferRequestSchema,
  CommunityWireOwnerTransferResponseSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import { requireLiveRole, requireMember, transaction, type Member } from '../data.js';
import { ApiError, json, readJson } from '../http.js';

async function live(client: PoolClient, id: string, communityId: string) {
  const result = await client.query<Member>(
    'SELECT id,user_id,display_name,role,community_id FROM members WHERE id=$1 AND community_id=$2 AND active FOR UPDATE',
    [id, communityId]
  );
  return result.rows[0];
}

async function remove(client: PoolClient, target: Member, actorId: string, action: string) {
  await client.query('UPDATE members SET active=false,removed_at=now() WHERE id=$1', [target.id]);
  await client.query('DELETE FROM channel_members WHERE member_id=$1', [target.id]);
  await client.query(
    'DELETE FROM agent_channel_members WHERE agent_id IN (SELECT id FROM agents WHERE owner_member_id=$1)',
    [target.id]
  );
  await client.query(
    'UPDATE agents SET active=false,revoked_at=now() WHERE owner_member_id=$1 AND active',
    [target.id]
  );
  await client.query(
    'UPDATE agent_credentials SET revoked_at=now() WHERE agent_id IN (SELECT id FROM agents WHERE owner_member_id=$1) AND revoked_at IS NULL',
    [target.id]
  );
  await client.query(
    'UPDATE connection_grants SET revoked_at=now() WHERE member_id=$1 AND revoked_at IS NULL',
    [target.id]
  );
  await client.query('DELETE FROM session WHERE "userId"=$1', [target.user_id]);
  await client.query(
    'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
    [target.community_id, actorId, action, target.id]
  );
}

/** Register member removal, leave and password-confirmed ownership transfer. */
export function registerMemberRoutes(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
) {
  app.get('/api/v1/me', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const result = await pool.query<Member & { handle: string; created_at: Date }>(
      'SELECT id,user_id,display_name,role,community_id,handle,created_at FROM members WHERE id=$1 AND active',
      [actor.id]
    );
    const row = result.rows[0];
    const current = await requireMember(c, auth, pool);
    if (!row || current.id !== actor.id)
      throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
    return json(c, CommunityWireMemberResponseSchema, {
      member: {
        memberId: row.id,
        kind: 'human',
        displayName: row.display_name,
        handle: row.handle,
        role: row.role,
        ownerMemberId: null,
        joinedAt: row.created_at.toISOString(),
      },
    });
  });

  app.get('/api/v1/members', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const query = CommunityWireMemberDirectoryQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const limit = query.limit ?? 50;
    const rows = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin']);
      return client.query<Member & { handle: string; created_at: Date }>(
        `SELECT id,user_id,display_name,role,community_id,handle,created_at FROM members
         WHERE community_id=$1 AND active AND ($2::uuid IS NULL OR id>$2::uuid)
         ORDER BY id LIMIT $3`,
        [actor.community_id, query.cursor ?? null, limit + 1]
      );
    });
    const members = rows.rows.slice(0, limit);
    return json(c, CommunityWireMemberDirectoryPageSchema, {
      members: members.map((row) => ({
        memberId: row.id,
        kind: 'human' as const,
        displayName: row.display_name,
        handle: row.handle,
        role: row.role,
        ownerMemberId: null,
        joinedAt: row.created_at.toISOString(),
      })),
      nextCursor: rows.rows.length > limit ? members.at(-1)!.id : null,
    });
  });

  app.delete('/api/v1/members/:id', async (c) => {
    const actor = await requireMember(c, auth, pool);
    await transaction(pool, async (client) => {
      const current = await live(client, actor.id, actor.community_id);
      if (!current || current.role === 'member')
        throw new ApiError(403, 'FORBIDDEN', 'Your current role cannot remove members.');
      const target = await live(client, c.req.param('id'), actor.community_id);
      if (!target) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
      if (target.role === 'owner' || (target.role === 'admin' && current.role !== 'owner'))
        throw new ApiError(403, 'FORBIDDEN', 'This member cannot be removed by your role.');
      await remove(client, target, actor.id, 'member.remove');
    });
    return c.body(null, 204);
  });

  app.post('/api/v1/me/leave', async (c) => {
    const actor = await requireMember(c, auth, pool);
    await transaction(pool, async (client) => {
      const current = await live(client, actor.id, actor.community_id);
      if (!current) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
      if (current.role === 'owner')
        throw new ApiError(403, 'FORBIDDEN', 'Transfer ownership before leaving.');
      await remove(client, current, actor.id, 'member.leave');
    });
    return c.body(null, 204);
  });

  app.post('/api/v1/owner/transfer', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireOwnerTransferRequestSchema);
    try {
      await auth.api.verifyPassword({
        headers: c.req.raw.headers,
        body: { password: body.password },
      });
    } catch {
      throw new ApiError(403, 'FORBIDDEN', 'Reauthentication failed.');
    }
    await transaction(pool, async (client) => {
      const current = await live(client, actor.id, actor.community_id);
      if (!current || current.role !== 'owner')
        throw new ApiError(403, 'FORBIDDEN', 'Only the current owner can transfer ownership.');
      if (actor.id === body.successorMemberId)
        throw new ApiError(409, 'STATE_CONFLICT', 'Choose another member.');
      const successor = await live(client, body.successorMemberId, actor.community_id);
      if (!successor) throw new ApiError(404, 'NOT_FOUND', 'Successor not found.');
      if (successor.role === 'owner')
        throw new ApiError(409, 'STATE_CONFLICT', 'That member already owns this community.');
      await client.query("UPDATE members SET role='member' WHERE id=$1", [current.id]);
      await client.query("UPDATE members SET role='owner' WHERE id=$1", [successor.id]);
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [actor.community_id, actor.id, 'owner.transfer', successor.id]
      );
    });
    return json(c, CommunityWireOwnerTransferResponseSchema, {
      ownerMemberId: body.successorMemberId,
    });
  });
}
