/**
 * Direct messages with an agent (DOR-2955, specs/everything-is-a-space C6).
 *
 * A direct message is a private channel of kind `dm` holding one person and one agent (0046).
 * It reads, posts, attaches and streams through the ordinary channel routes, whose membership
 * check already admits exactly those two. The agent's owner reads it through the agent's own
 * credential, never their own account, so it is not in the owner's personal export.
 *
 * Who else can see one, and how:
 *
 * - Nobody can read one in the space itself: not another member, not the space's owner or
 *   admins.
 * - A moderator sees a message a person reported from one, its excerpt and note, because the
 *   reporter chose to share it (`moderation/reports.ts`). Nothing else of it.
 * - Like every private channel, it is in the space owner's full export (moving a space keeps
 *   it) and in a host's legal-takedown evidence export.
 *
 * What is here is the rest:
 *
 * - `POST /dms {agentId}`: a person starts one, or finds the one already started. Refused unless
 *   the agent's owner turned direct messages on and both are still in the space.
 * - `GET /dms`: the caller's direct messages, a person's or an agent's.
 * - `PUT /agents/:id/dms {accepts}`: the agent's owner turns them on or off. Nobody else can,
 *   a space owner or admin included: it decides who reaches the owner's computer.
 *
 * And the refusals that keep a direct message two members: {@link refuseDirectMessage}, asked by
 * every route that would change a channel's members or settings.
 *
 * @module routes/community/agents/direct-messages
 */
import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityWireAgentDirectMessagesRequestSchema,
  CommunityWireAgentDirectMessagesResponseSchema,
  CommunityWireDirectMessageCreateRequestSchema,
  CommunityWireDirectMessageListResponseSchema,
  CommunityWireDirectMessageResponseSchema,
  type CommunityWireDirectMessage,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../../auth.js';
import {
  assertConnectionGrantCurrent,
  assertPrincipalCurrent,
  lockPrincipalAuthority,
  requireConnectionGrant,
  requireLiveRole,
  requireMember,
  requirePrincipal,
  transaction,
  type Member,
} from '../../../data.js';
import { ApiError, json, readJson } from '../../../http.js';
import { grantActsOn, grantScope } from './agent-scope.js';

const uuid = z.uuid();

/** What a direct message's name reads as wherever a channel's name is shown, as in an export. */
export const DIRECT_MESSAGE_NAME = 'Direct message';

/**
 * Refuse a change that would reshape a direct message: joining, leaving, adding or removing a
 * member or an agent, or editing its settings. It holds its person and its agent, nobody else.
 *
 * @param channel - The channel the route locked.
 */
export function refuseDirectMessage(channel: { kind: 'channel' | 'dm' }): void {
  if (channel.kind === 'dm')
    throw new ApiError(409, 'STATE_CONFLICT', 'A direct message has only its two members.');
}

/**
 * Refuse a person's new post into a direct message whose agent no longer takes them: its owner
 * turned them off, or the agent or its owner left. What was said stays readable, and the agent
 * can still read and reply; only the person's next message waits until its owner turns them on.
 *
 * @param client - The posting transaction.
 * @param channel - The channel the route locked.
 */
export async function refuseClosedDirectMessage(
  client: PoolClient,
  channel: { kind: 'channel' | 'dm'; dm_agent_id: string | null; community_id: string }
): Promise<void> {
  if (channel.kind !== 'dm' || channel.dm_agent_id === null) return;
  const open = await client.query<{ open: boolean }>(
    // member-kind: agent-owner
    `SELECT (a.accepts_dms AND a.active AND owner.active) AS open FROM agents a
     JOIN members owner ON owner.community_id=a.community_id AND owner.id=a.owner_member_id
     WHERE a.id=$1 AND a.community_id=$2`,
    [channel.dm_agent_id, channel.community_id]
  );
  if (open.rows[0]?.open !== true)
    throw new ApiError(409, 'AGENT_NOT_TAKING_DMS', 'This agent is not taking direct messages.');
}

interface DirectMessageRow {
  id: string;
  created_at: Date;
  unread_count: string;
  member_id: string;
  member_name: string;
  agent_id: string;
  agent_name: string;
  agent_handle: string;
  owner_id: string;
  owner_name: string;
}

/**
 * Every direct message one principal holds, newest last; one, when `$4` names it. `$1` is the
 * principal, `$2` its space, `$3` whether it is an agent.
 */
const DIRECT_MESSAGES_SQL =
  // member-kind: agent-owner
  `SELECT c.id,c.created_at,GREATEST(c.last_seq-COALESCE(rc.seq,0),0)::text AS unread_count,
     person.id AS member_id,person.display_name AS member_name,
     a.id AS agent_id,a.display_name AS agent_name,a.handle AS agent_handle,
     owner.id AS owner_id,owner.display_name AS owner_name
   FROM channels c
   JOIN members person ON person.community_id=c.community_id AND person.id=c.dm_member_id
     AND person.kind='person'
   JOIN agents a ON a.community_id=c.community_id AND a.id=c.dm_agent_id
   JOIN members owner ON owner.community_id=a.community_id AND owner.id=a.owner_member_id
   LEFT JOIN read_cursors rc ON rc.channel_id=c.id AND rc.member_id=$1
   WHERE c.community_id=$2 AND c.kind='dm' AND ($4::uuid IS NULL OR c.id=$4::uuid)
     AND CASE WHEN $3::boolean
       THEN EXISTS (SELECT 1 FROM agent_channel_members acm WHERE acm.channel_id=c.id AND acm.agent_id=$1)
       ELSE EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.member_id=$1) END
   ORDER BY c.created_at,c.id`;

function project(row: DirectMessageRow): CommunityWireDirectMessage {
  return {
    id: row.id,
    member: { memberId: row.member_id, displayName: row.member_name },
    agent: {
      memberId: row.agent_id,
      displayName: row.agent_name,
      handle: row.agent_handle,
      ownerMemberId: row.owner_id,
      ownerDisplayName: row.owner_name,
    },
    createdAt: row.created_at.toISOString(),
    unreadCount: Number(row.unread_count),
  };
}

async function readDirectMessages(
  db: Pick<Pool | PoolClient, 'query'>,
  principal: { id: string; community_id: string; kind: 'human' | 'agent' },
  channelId: string | null = null
): Promise<CommunityWireDirectMessage[]> {
  const rows = await db.query<DirectMessageRow>(DIRECT_MESSAGES_SQL, [
    principal.id,
    principal.community_id,
    principal.kind === 'agent',
    channelId,
  ]);
  return rows.rows.map(project);
}

/** Register direct-message discovery, creation and the owner's switch. */
export function registerDirectMessageRoutes(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
) {
  app.get('/dms', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    const dms = await readDirectMessages(pool, principal);
    await assertPrincipalCurrent(c, auth, pool, principal, 'read');
    return json(c, CommunityWireDirectMessageListResponseSchema, { dms });
  });

  app.post('/dms', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'post');
    if (principal.kind !== 'human')
      throw new ApiError(403, 'FORBIDDEN', 'Only a person can start a direct message.');
    const { agentId } = await readJson(c, CommunityWireDirectMessageCreateRequestSchema);
    if (!uuid.safeParse(agentId).success) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
    const { id, created } = await transaction(pool, async (client) => {
      await lockPrincipalAuthority(client, principal, 'post');
      await requireLiveRole(client, principal as unknown as Member, ['owner', 'admin', 'member']);
      const agent = await client.query<{ accepts_dms: boolean; reachable: boolean }>(
        // member-kind: agent-owner
        `SELECT a.accepts_dms,(a.active AND owner.active) AS reachable FROM agents a
         JOIN members owner ON owner.community_id=a.community_id AND owner.id=a.owner_member_id
         WHERE a.id=$1 AND a.community_id=$2 FOR SHARE OF a`,
        [agentId, principal.community_id]
      );
      if (!agent.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      if (!agent.rows[0].accepts_dms || !agent.rows[0].reachable)
        throw new ApiError(
          409,
          'AGENT_NOT_TAKING_DMS',
          'This agent is not taking direct messages.'
        );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO channels(community_id,name,visibility,kind,dm_member_id,dm_agent_id)
         VALUES($1,$2,'private','dm',$3,$4)
         ON CONFLICT (community_id,dm_member_id,dm_agent_id) WHERE kind='dm' DO NOTHING
         RETURNING id`,
        [principal.community_id, DIRECT_MESSAGE_NAME, principal.id, agentId]
      );
      const found =
        inserted.rows[0] ??
        (
          await client.query<{ id: string }>(
            `SELECT id FROM channels WHERE community_id=$1 AND kind='dm'
             AND dm_member_id=$2 AND dm_agent_id=$3`,
            [principal.community_id, principal.id, agentId]
          )
        ).rows[0]!;
      // Both memberships, again on a direct message that already existed: a person who left
      // the space and came back, or an agent removed and enrolled again, finds it whole.
      await client.query(
        'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [principal.community_id, found.id, principal.id]
      );
      await client.query(
        'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [principal.community_id, found.id, agentId]
      );
      return { id: found.id, created: inserted.rows.length > 0 };
    });
    const [dm] = await readDirectMessages(pool, principal, id);
    if (!dm) throw new ApiError(404, 'NOT_FOUND', 'Direct message not found.');
    return json(c, CommunityWireDirectMessageResponseSchema, { dm }, created ? 201 : 200);
  });

  app.put('/agents/:id/dms', async (c) => {
    const grant = c.req.header('authorization')
      ? await requireConnectionGrant(c, pool, 'enroll-agent')
      : undefined;
    const actor = grant?.member ?? (await requireMember(c, auth, pool));
    const { accepts } = await readJson(c, CommunityWireAgentDirectMessagesRequestSchema);
    const agentId = c.req.param('id');
    if (!uuid.safeParse(agentId).success) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
    await transaction(pool, async (client) => {
      if (grant)
        await assertConnectionGrantCurrent(
          client,
          actor.id,
          grant.tokenHash,
          actor.community_id,
          'enroll-agent'
        );
      await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
      const agent = await client.query<{ owner_member_id: string; in_scope: boolean }>(
        `SELECT a.owner_member_id,${grantScope('a', '$3::uuid')} AS in_scope FROM agents a
         WHERE a.id=$1 AND a.community_id=$2 AND a.active FOR UPDATE`,
        [agentId, actor.community_id, grant?.member.grant_id ?? null]
      );
      // Another installation's agent is not found by this one, as everywhere a grant acts.
      if (!agent.rows[0] || (grant && !grantActsOn(agent.rows[0], actor.id)))
        throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      if (agent.rows[0].owner_member_id !== actor.id)
        throw new ApiError(403, 'FORBIDDEN', 'Only its owner decides who can message an agent.');
      await client.query('UPDATE agents SET accepts_dms=$3 WHERE id=$1 AND community_id=$2', [
        agentId,
        actor.community_id,
        accepts,
      ]);
    });
    return json(c, CommunityWireAgentDirectMessagesResponseSchema, {
      agentId,
      acceptsDms: accepts,
    });
  });
}
