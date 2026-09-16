import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  CommunityWireAgentEnrollRequestSchema,
  CommunityWireAgentListResponseSchema,
  CommunityWireAgentChannelMembershipRequestSchema,
  CommunityWireAgentChannelMembershipResponseSchema,
} from '@dorkos/shared/community-wire';
import { CommunityAgentEnrollmentSecretResponseSchema } from '@dorkos/shared/community-private-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import {
  lockChannel,
  requireConnectionGrant,
  requireLiveRole,
  requireMember,
  transaction,
} from '../data.js';
import { mintHandle } from '../handles.js';
import { ApiError, json, readJson } from '../http.js';
import { hashSecret, randomToken } from '../security.js';

const uuid = z.uuid();
interface AgentRow {
  id: string;
  display_name: string;
  handle: string;
  owner_member_id: string;
  active: boolean;
}
function project(row: AgentRow) {
  return {
    memberId: row.id,
    displayName: row.display_name,
    handle: row.handle,
    ownerMemberId: row.owner_member_id,
    active: row.active,
  };
}

/** Register owner-bound agent credentials and explicit channel membership. */
export function registerAgentRoutes(
  app: Hono,
  { pool, auth, config }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig }
) {
  app.post('/api/v1/agents', async (c) => {
    const { member, tokenHash } = await requireConnectionGrant(c, pool, 'enroll-agent');
    const body = await readJson(c, CommunityWireAgentEnrollRequestSchema);
    const result = await transaction(pool, async (client) => {
      const owner = await client.query('SELECT 1 FROM members WHERE id=$1 AND active FOR UPDATE', [
        member.id,
      ]);
      if (!owner.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Owner membership has ended.');
      const grant = await client.query(
        "SELECT 1 FROM connection_grants WHERE member_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND scopes @> ARRAY['enroll-agent']::text[] FOR SHARE",
        [member.id, tokenHash]
      );
      if (!grant.rowCount)
        throw new ApiError(401, 'UNAUTHENTICATED', 'This connection is unavailable.');
      const existing = await client.query(
        'SELECT 1 FROM agents WHERE owner_member_id=$1 AND local_agent_id=$2',
        [member.id, body.localAgentId]
      );
      if (existing.rowCount)
        throw new ApiError(409, 'STATE_CONFLICT', 'This local agent is already enrolled.');
      const count = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM agents WHERE owner_member_id=$1 AND active',
        [member.id]
      );
      if (Number(count.rows[0].n) >= config.limits.agentsPerOwner)
        throw new ApiError(429, 'RATE_LIMITED', 'Active agent limit reached.');
      const handle =
        body.handle ?? (await mintHandle(client, member.community_id, body.displayName));
      const agent = await client.query<AgentRow>(
        'INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id) VALUES($1,$2,$3,$4,$5) RETURNING id,display_name,handle,owner_member_id,active',
        [member.community_id, member.id, body.displayName, handle, body.localAgentId]
      );
      await client.query(
        'INSERT INTO community_handles(community_id,handle,agent_id) VALUES($1,$2,$3)',
        [member.community_id, handle, agent.rows[0].id]
      );
      const token = randomToken();
      await client.query('INSERT INTO agent_credentials(agent_id,token_hash) VALUES($1,$2)', [
        agent.rows[0].id,
        hashSecret(token),
      ]);
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [member.community_id, member.id, 'agent.enroll', agent.rows[0].id]
      );
      return { token, agent: project(agent.rows[0]) };
    });
    const out = json(c, CommunityAgentEnrollmentSecretResponseSchema, result, 201);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  });

  app.get('/api/v1/agents', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const rows = await pool.query<AgentRow>(
      'SELECT id,display_name,handle,owner_member_id,active FROM agents WHERE community_id=$1 AND owner_member_id=$2 AND active ORDER BY created_at,id',
      [actor.community_id, actor.id]
    );
    return json(c, CommunityWireAgentListResponseSchema, { agents: rows.rows.map(project) });
  });

  app.post('/api/v1/agents/:id/rotate', async (c) => {
    const { member, tokenHash } = await requireConnectionGrant(c, pool, 'enroll-agent');
    const id = uuid.parse(c.req.param('id'));
    const result = await transaction(pool, async (client) => {
      const owner = await client.query('SELECT 1 FROM members WHERE id=$1 AND active FOR UPDATE', [
        member.id,
      ]);
      if (!owner.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Owner membership has ended.');
      const grant = await client.query(
        "SELECT 1 FROM connection_grants WHERE member_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND scopes @> ARRAY['enroll-agent']::text[] FOR SHARE",
        [member.id, tokenHash]
      );
      if (!grant.rowCount)
        throw new ApiError(401, 'UNAUTHENTICATED', 'This connection is unavailable.');
      const agent = await client.query<AgentRow>(
        'SELECT id,display_name,handle,owner_member_id,active FROM agents WHERE id=$1 AND owner_member_id=$2 AND active FOR UPDATE',
        [id, member.id]
      );
      if (!agent.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      await client.query(
        'UPDATE agent_credentials SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL',
        [id]
      );
      const token = randomToken();
      await client.query('INSERT INTO agent_credentials(agent_id,token_hash) VALUES($1,$2)', [
        id,
        hashSecret(token),
      ]);
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [member.community_id, member.id, 'agent.rotate', id]
      );
      return { token, agent: project(agent.rows[0]) };
    });
    const out = json(c, CommunityAgentEnrollmentSecretResponseSchema, result);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  });

  app.delete('/api/v1/agents/:id', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const id = uuid.parse(c.req.param('id'));
    await transaction(pool, async (client) => {
      const role = await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
      const target = await client.query<AgentRow & { owner_role: 'owner' | 'admin' | 'member' }>(
        'SELECT a.id,a.owner_member_id,m.role AS owner_role FROM agents a JOIN members m ON m.id=a.owner_member_id WHERE a.id=$1 AND a.community_id=$2 AND a.active FOR UPDATE OF a',
        [id, actor.community_id]
      );
      const row = target.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      if (
        row.owner_member_id !== actor.id &&
        (role === 'member' || (role === 'admin' && row.owner_role !== 'member'))
      )
        throw new ApiError(403, 'FORBIDDEN', 'You cannot remove this agent.');
      await client.query('UPDATE agents SET active=false,revoked_at=now() WHERE id=$1', [id]);
      await client.query(
        'UPDATE agent_credentials SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL',
        [id]
      );
      await client.query('DELETE FROM agent_channel_members WHERE agent_id=$1', [id]);
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [actor.community_id, actor.id, 'agent.eject', id]
      );
    });
    return c.body(null, 204);
  });

  app.post('/api/v1/channels/:id/agents', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const { agentId } = await readJson(c, CommunityWireAgentChannelMembershipRequestSchema);
    await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), actor);
      const role = await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
      const agent = await client.query<{ owner_member_id: string }>(
        'SELECT owner_member_id FROM agents WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
        [agentId, actor.community_id]
      );
      if (!agent.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      if (agent.rows[0].owner_member_id !== actor.id && !['owner', 'admin'].includes(role))
        throw new ApiError(403, 'FORBIDDEN', 'You cannot add this agent.');
      if (channel.archived) throw new ApiError(409, 'STATE_CONFLICT', 'This channel is archived.');
      await client.query(
        'INSERT INTO agent_channel_members(channel_id,agent_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [channel.id, agentId]
      );
    });
    return json(c, CommunityWireAgentChannelMembershipResponseSchema, { joined: true });
  });

  app.delete('/api/v1/channels/:id/agents/:agentId', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const agentId = uuid.parse(c.req.param('agentId'));
    await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), actor);
      const role = await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
      const agent = await client.query<{ owner_member_id: string }>(
        'SELECT owner_member_id FROM agents WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
        [agentId, actor.community_id]
      );
      if (!agent.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      if (agent.rows[0].owner_member_id !== actor.id && !['owner', 'admin'].includes(role))
        throw new ApiError(403, 'FORBIDDEN', 'You cannot remove this agent.');
      await client.query('DELETE FROM agent_channel_members WHERE channel_id=$1 AND agent_id=$2', [
        channel.id,
        agentId,
      ]);
    });
    return c.body(null, 204);
  });
}
