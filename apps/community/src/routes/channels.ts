import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityWireChannelCreateRequestSchema,
  CommunityWireChannelListResponseSchema,
  CommunityWireChannelMemberRequestSchema,
  CommunityWireChannelResponseSchema,
  CommunityWireChannelUpdateRequestSchema,
  CommunityWireMemberListResponseSchema,
  CommunityWireMemberResponseSchema,
  CommunityWireMemberRoleUpdateRequestSchema,
  type CommunityWireChannel,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import {
  assertPrincipalCurrent,
  lockChannel,
  requireLiveRole,
  requireMember,
  requirePrincipal,
  transaction,
  type Member,
  type Principal,
} from '../data.js';
import { ApiError, json, readJson } from '../http.js';

interface ChannelRow {
  id: string;
  name: string;
  description: string | null;
  visibility: 'public' | 'private';
  archived: boolean;
  created_at: Date;
  joined: boolean;
  unread_count: string;
}

function project(row: ChannelRow): CommunityWireChannel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    archived: row.archived,
    createdAt: row.created_at.toISOString(),
    joined: row.joined,
    unreadCount: Number(row.unread_count),
  };
}

async function channelProjection(pool: Pool, id: string, member: Member | Principal) {
  const agent = 'kind' in member && member.kind === 'agent';
  const result = await pool.query<ChannelRow>(
    `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,
      EXISTS(SELECT 1 FROM ${agent ? 'agent_channel_members' : 'channel_members'} cm WHERE cm.channel_id=c.id AND cm.${agent ? 'agent_id' : 'member_id'}=$2) AS joined,
      GREATEST(c.last_seq-COALESCE(rc.seq,0),0)::text AS unread_count
     FROM channels c LEFT JOIN read_cursors rc ON rc.channel_id=c.id AND rc.member_id=$2
     WHERE c.id=$1 AND c.community_id=$3`,
    [id, member.id, member.community_id]
  );
  const row = result.rows[0];
  if (!row || (agent && !row.joined) || (row.visibility === 'private' && !row.joined)) {
    throw new ApiError(404, 'NOT_FOUND', 'Channel not found.');
  }
  return project(row);
}

/** Register channel discovery, membership and moderator routes. */
export function registerChannelRoutes(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
) {
  app.get('/api/v1/channels', async (c) => {
    const member = await requirePrincipal(c, auth, pool, 'read');
    const agent = member.kind === 'agent';
    const result = await pool.query<ChannelRow>(
      `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,
        (cm.${agent ? 'agent_id' : 'member_id'} IS NOT NULL) AS joined,
        GREATEST(c.last_seq-COALESCE(rc.seq,0),0)::text AS unread_count
       FROM channels c
       LEFT JOIN ${agent ? 'agent_channel_members' : 'channel_members'} cm ON cm.channel_id=c.id AND cm.${agent ? 'agent_id' : 'member_id'}=$1
       LEFT JOIN read_cursors rc ON rc.channel_id=c.id AND rc.member_id=$1
       WHERE c.community_id=$2 AND ${agent ? 'cm.agent_id IS NOT NULL' : "(c.visibility='public' OR cm.member_id IS NOT NULL)"}
       ORDER BY c.created_at,c.id`,
      [member.id, member.community_id]
    );
    await assertPrincipalCurrent(c, auth, pool, member, 'read');
    return json(c, CommunityWireChannelListResponseSchema, { channels: result.rows.map(project) });
  });

  app.post('/api/v1/channels', async (c) => {
    const member = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireChannelCreateRequestSchema);
    const id = await transaction(pool, async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO channels(community_id,name,description,visibility) VALUES($1,$2,$3,$4) RETURNING id`,
        [member.community_id, body.name, body.description ?? null, body.visibility ?? 'public']
      );
      // A concurrent demotion may complete while INSERT waits; this check is inside the transaction.
      await requireLiveRole(client, member, ['owner', 'admin']);
      await client.query('INSERT INTO channel_members(channel_id,member_id) VALUES($1,$2)', [
        row.rows[0].id,
        member.id,
      ]);
      return row.rows[0].id;
    });
    const channel = await channelProjection(pool, id, member);
    return json(c, CommunityWireChannelResponseSchema, { channel }, 201);
  });

  app.get('/api/v1/channels/:id', async (c) => {
    const member = await requirePrincipal(c, auth, pool, 'read');
    const channel = await channelProjection(pool, c.req.param('id'), member);
    await assertPrincipalCurrent(c, auth, pool, member, 'read');
    return json(c, CommunityWireChannelResponseSchema, {
      channel,
    });
  });

  app.patch('/api/v1/channels/:id', async (c) => {
    const member = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireChannelUpdateRequestSchema);
    await transaction(pool, async (client) => {
      await lockChannel(client, c.req.param('id'), member);
      await requireLiveRole(client, member, ['owner', 'admin']);
      await client.query(
        `UPDATE channels SET name=COALESCE($2,name),description=CASE WHEN $3::boolean THEN $4 ELSE description END,
           archived=COALESCE($5,archived),epoch=epoch+1 WHERE id=$1`,
        [
          c.req.param('id'),
          body.name ?? null,
          'description' in body,
          body.description ?? null,
          body.archived ?? null,
        ]
      );
    });
    return json(c, CommunityWireChannelResponseSchema, {
      channel: await channelProjection(pool, c.req.param('id'), member),
    });
  });

  app.post('/api/v1/channels/:id/join', async (c) => {
    const member = await requireMember(c, auth, pool);
    await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), member);
      await requireLiveRole(client, member, ['owner', 'admin', 'member']);
      if (channel.archived) throw new ApiError(409, 'STATE_CONFLICT', 'This channel is archived.');
      if (channel.visibility === 'private' && !channel.joined)
        throw new ApiError(404, 'NOT_FOUND', 'Channel not found.');
      await client.query(
        'INSERT INTO channel_members(channel_id,member_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [channel.id, member.id]
      );
    });
    return json(c, CommunityWireChannelResponseSchema, {
      channel: await channelProjection(pool, c.req.param('id'), member),
    });
  });

  app.post('/api/v1/channels/:id/leave', async (c) => {
    const member = await requireMember(c, auth, pool);
    await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), member);
      await requireLiveRole(client, member, ['owner', 'admin', 'member']);
      await client.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
        channel.id,
        member.id,
      ]);
    });
    return json(c, CommunityWireChannelResponseSchema, {
      channel: await channelProjection(pool, c.req.param('id'), member),
    });
  });

  app.get('/api/v1/channels/:id/members', async (c) => {
    const member = await requirePrincipal(c, auth, pool, 'read');
    const channel = await channelProjection(pool, c.req.param('id'), member);
    if (!channel.joined) throw new ApiError(403, 'FORBIDDEN', 'Join this channel first.');
    const rows = await pool.query<{
      id: string;
      display_name: string;
      handle: string;
      role: Member['role'] | null;
      owner_member_id: string | null;
      owner_display_name: string | null;
      kind: 'human' | 'agent';
      joined_at: Date;
    }>(
      `SELECT m.id,m.display_name,m.handle,m.role,NULL::uuid AS owner_member_id,NULL::text AS owner_display_name,'human' AS kind,cm.joined_at
       FROM channel_members cm JOIN members m ON m.id=cm.member_id
       WHERE cm.channel_id=$1 AND m.active
       UNION ALL SELECT a.id,a.display_name,a.handle,NULL::text AS role,a.owner_member_id,owner.display_name AS owner_display_name,'agent' AS kind,acm.joined_at
       FROM agent_channel_members acm JOIN agents a ON a.id=acm.agent_id
       JOIN members owner ON owner.id=a.owner_member_id
       WHERE acm.channel_id=$1 AND a.active AND owner.active
       ORDER BY joined_at,id`,
      [channel.id]
    );
    await assertPrincipalCurrent(c, auth, pool, member, 'read');
    return json(c, CommunityWireMemberListResponseSchema, {
      members: rows.rows.map((row) => ({
        memberId: row.id,
        kind: row.kind,
        displayName: row.display_name,
        handle: row.handle,
        role: row.role,
        ownerMemberId: row.owner_member_id,
        ownerDisplayName: row.owner_display_name,
        joinedAt: row.joined_at.toISOString(),
      })),
    });
  });

  app.post('/api/v1/channels/:id/members', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireChannelMemberRequestSchema);
    await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), actor);
      await requireLiveRole(client, actor, ['owner', 'admin']);
      if (channel.archived) throw new ApiError(409, 'STATE_CONFLICT', 'This channel is archived.');
      const target = await client.query(
        'SELECT 1 FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
        [body.memberId, actor.community_id]
      );
      if (!target.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
      await client.query(
        'INSERT INTO channel_members(channel_id,member_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [channel.id, body.memberId]
      );
    });
    return json(c, CommunityWireChannelResponseSchema, {
      channel: await channelProjection(pool, c.req.param('id'), actor),
    });
  });

  app.delete('/api/v1/channels/:id/members/:memberId', async (c) => {
    const actor = await requireMember(c, auth, pool);
    await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), actor);
      const actorRole = await requireLiveRole(client, actor, ['owner', 'admin']);
      const target = await client.query<{ role: Member['role'] }>(
        'SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
        [c.req.param('memberId'), actor.community_id]
      );
      if (!target.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
      if (
        target.rows[0].role === 'owner' ||
        (target.rows[0].role === 'admin' && actorRole !== 'owner')
      ) {
        throw new ApiError(403, 'FORBIDDEN', 'This member cannot be removed by your role.');
      }
      await client.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
        channel.id,
        c.req.param('memberId'),
      ]);
    });
    return json(c, CommunityWireChannelResponseSchema, {
      channel: await channelProjection(pool, c.req.param('id'), actor),
    });
  });

  app.patch('/api/v1/members/:id/role', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireMemberRoleUpdateRequestSchema);
    const member = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner']);
      const result = await client.query<{
        id: string;
        display_name: string;
        handle: string;
        role: Member['role'];
        joined_at: Date;
      }>(
        `UPDATE members SET role=$1 WHERE id=$2 AND community_id=$3 AND active AND role<>'owner'
         RETURNING id,display_name,handle,role,created_at AS joined_at`,
        [body.role, c.req.param('id'), actor.community_id]
      );
      if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [actor.community_id, actor.id, 'member.role', result.rows[0].id]
      );
      return result.rows[0];
    });
    return json(c, CommunityWireMemberResponseSchema, {
      member: {
        memberId: member.id,
        kind: 'human',
        displayName: member.display_name,
        handle: member.handle,
        role: member.role,
        ownerMemberId: null,
        joinedAt: member.joined_at.toISOString(),
      },
    });
  });
}
