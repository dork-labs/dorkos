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
  assertConnectionGrantCurrent,
  lockChannel,
  requireConnectionGrant,
  requireLiveRole,
  requireMember,
  transaction,
  type Member,
} from '../data.js';
import { mintHandle } from '../handles.js';
import { ApiError, json, readJson } from '../http.js';
import { agentLimitReached, effectiveAgentLimit } from '../host/limits.js';
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
  app.post('/agents', async (c) => {
    const { member, tokenHash } = await requireConnectionGrant(c, pool, 'enroll-agent');
    const body = await readJson(c, CommunityWireAgentEnrollRequestSchema);
    const result = await transaction(pool, async (client) => {
      await assertConnectionGrantCurrent(
        client,
        member.id,
        tokenHash,
        member.community_id,
        'enroll-agent'
      );
      const existing = await client.query<AgentRow>(
        'SELECT id,display_name,handle,owner_member_id,active FROM agents WHERE owner_member_id=$1 AND community_id=$2 AND local_agent_id=$3 FOR UPDATE',
        [member.id, member.community_id, body.localAgentId]
      );
      if (existing.rows[0]?.active)
        throw new ApiError(409, 'STATE_CONFLICT', 'This local agent is already enrolled.');
      const count = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM agents WHERE owner_member_id=$1 AND community_id=$2 AND active',
        [member.id, member.community_id]
      );
      const limit = await effectiveAgentLimit(
        client,
        member.community_id,
        member.id,
        config.limits.agentsPerOwner
      );
      if (Number(count.rows[0].n) >= limit) throw agentLimitReached();
      const agent = existing.rows[0]
        ? await client.query<AgentRow>(
            'UPDATE agents SET active=true,revoked_at=NULL,display_name=$3 WHERE id=$1 AND community_id=$2 RETURNING id,display_name,handle,owner_member_id,active',
            [existing.rows[0].id, member.community_id, body.displayName]
          )
        : await (async () => {
            const handle =
              body.handle ?? (await mintHandle(client, member.community_id, body.displayName));
            const created = await client.query<AgentRow>(
              'INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id) VALUES($1,$2,$3,$4,$5) RETURNING id,display_name,handle,owner_member_id,active',
              [member.community_id, member.id, body.displayName, handle, body.localAgentId]
            );
            await client.query(
              'INSERT INTO community_handles(community_id,handle,agent_id) VALUES($1,$2,$3)',
              [member.community_id, handle, created.rows[0].id]
            );
            return created;
          })();
      // Reactivation is a new authority: old room memberships and credentials
      // cannot survive an ejection or a lost initial response.
      await client.query(
        'DELETE FROM agent_channel_members WHERE agent_id=$1 AND community_id=$2',
        [agent.rows[0].id, member.community_id]
      );
      await client.query(
        'UPDATE agent_credentials SET revoked_at=now() WHERE agent_id=$1 AND community_id=$2 AND revoked_at IS NULL',
        [agent.rows[0].id, member.community_id]
      );
      const token = randomToken();
      await client.query(
        'INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,$3)',
        [member.community_id, agent.rows[0].id, hashSecret(token)]
      );
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

  app.get('/agents', async (c) => {
    const grant = c.req.header('authorization')
      ? await requireConnectionGrant(c, pool, 'enroll-agent')
      : undefined;
    const actor = grant?.member ?? (await requireMember(c, auth, pool));
    const rows = await pool.query<AgentRow>(
      'SELECT id,display_name,handle,owner_member_id,active FROM agents WHERE community_id=$1 AND owner_member_id=$2 AND active ORDER BY created_at,id',
      [actor.community_id, actor.id]
    );
    return json(c, CommunityWireAgentListResponseSchema, { agents: rows.rows.map(project) });
  });

  // A client can lose the one-time enrollment response after the transaction
  // commits. The owner-scoped local id is the recovery key; this endpoint is
  // deliberately distinct from ordinary enrollment so retries never rotate a
  // still-working credential.
  app.post('/agents/recover', async (c) => {
    const { member, tokenHash } = await requireConnectionGrant(c, pool, 'enroll-agent');
    const body = await readJson(c, CommunityWireAgentEnrollRequestSchema);
    const result = await transaction(pool, async (client) => {
      await assertConnectionGrantCurrent(
        client,
        member.id,
        tokenHash,
        member.community_id,
        'enroll-agent'
      );
      const agent = await client.query<AgentRow>(
        'SELECT id,display_name,handle,owner_member_id,active FROM agents WHERE owner_member_id=$1 AND community_id=$2 AND local_agent_id=$3 AND active FOR UPDATE',
        [member.id, member.community_id, body.localAgentId]
      );
      if (!agent.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Active agent not found.');
      await client.query(
        'UPDATE agent_credentials SET revoked_at=now() WHERE agent_id=$1 AND community_id=$2 AND revoked_at IS NULL',
        [agent.rows[0].id, member.community_id]
      );
      const token = randomToken();
      await client.query(
        'INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,$3)',
        [member.community_id, agent.rows[0].id, hashSecret(token)]
      );
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [member.community_id, member.id, 'agent.recover', agent.rows[0].id]
      );
      return { token, agent: project(agent.rows[0]) };
    });
    const out = json(c, CommunityAgentEnrollmentSecretResponseSchema, result);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  });

  app.post('/agents/:id/rotate', async (c) => {
    const { member, tokenHash } = await requireConnectionGrant(c, pool, 'enroll-agent');
    const id = uuid.parse(c.req.param('id'));
    const result = await transaction(pool, async (client) => {
      await assertConnectionGrantCurrent(
        client,
        member.id,
        tokenHash,
        member.community_id,
        'enroll-agent'
      );
      const agent = await client.query<AgentRow>(
        'SELECT id,display_name,handle,owner_member_id,active FROM agents WHERE id=$1 AND owner_member_id=$2 AND community_id=$3 AND active FOR UPDATE',
        [id, member.id, member.community_id]
      );
      if (!agent.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      await client.query(
        'UPDATE agent_credentials SET revoked_at=now() WHERE agent_id=$1 AND community_id=$2 AND revoked_at IS NULL',
        [id, member.community_id]
      );
      const token = randomToken();
      await client.query(
        'INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,$3)',
        [member.community_id, id, hashSecret(token)]
      );
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

  // Removing an agent is not growth, so it works while the host holds the community.
  app.delete('/agents/:id', async (c) => {
    const grant = c.req.header('authorization')
      ? await requireConnectionGrant(c, pool, 'enroll-agent', { allowHeld: true })
      : undefined;
    const actor = grant?.member ?? (await requireMember(c, auth, pool));
    const id = uuid.parse(c.req.param('id'));
    const preliminary = await pool.query<{
      actor_role: Member['role'];
      owner_member_id: string;
      owner_role: Member['role'];
    }>(
      `SELECT actor.role AS actor_role,a.owner_member_id,owner.role AS owner_role
       FROM members actor
       JOIN agents a ON a.id=$1 AND a.community_id=actor.community_id AND a.active
       JOIN members owner ON owner.id=a.owner_member_id AND owner.community_id=actor.community_id AND owner.active
       WHERE actor.id=$2 AND actor.community_id=$3 AND actor.active`,
      [id, actor.id, actor.community_id]
    );
    const observed = preliminary.rows[0];
    if (
      observed &&
      observed.owner_member_id !== actor.id &&
      (observed.actor_role === 'member' ||
        (observed.actor_role === 'admin' && observed.owner_role !== 'member'))
    ) {
      throw new ApiError(403, 'FORBIDDEN', 'You cannot remove this agent.');
    }
    await transaction(pool, async (client) => {
      if (grant)
        await assertConnectionGrantCurrent(
          client,
          actor.id,
          grant.tokenHash,
          actor.community_id,
          'enroll-agent',
          { allowHeld: true }
        );
      const role = await requireLiveRole(client, actor, ['owner', 'admin', 'member'], {
        allowHeld: true,
      });
      const candidate = await client.query<{ owner_member_id: string; owner_role: Member['role'] }>(
        'SELECT a.owner_member_id,m.role AS owner_role FROM agents a JOIN members m ON m.id=a.owner_member_id WHERE a.id=$1 AND a.community_id=$2 AND a.active AND m.active',
        [id, actor.community_id]
      );
      if (!candidate.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      const isOtherMember = candidate.rows[0].owner_member_id !== actor.id;
      if (
        isOtherMember &&
        (role === 'member' || (role === 'admin' && candidate.rows[0].owner_role !== 'member'))
      )
        throw new ApiError(403, 'FORBIDDEN', 'You cannot remove this agent.');
      // Only a moderator ejecting another ordinary member needs the target owner
      // lock. An admin checking an owner would invert owner-transfer's O→A order.
      // Early denial above is conservative if a concurrent demotion is pending.
      const owner =
        role === 'admin' && isOtherMember
          ? await client.query<{ role: Member['role'] }>(
              'SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
              [candidate.rows[0].owner_member_id, actor.community_id]
            )
          : null;
      const target = await client.query<{ id: string; owner_member_id: string }>(
        'SELECT id,owner_member_id FROM agents WHERE id=$1 AND community_id=$2 AND active FOR UPDATE',
        [id, actor.community_id]
      );
      const row = target.rows[0];
      if (
        !row ||
        row.owner_member_id !== candidate.rows[0].owner_member_id ||
        (owner && !owner.rows[0])
      )
        throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      if (owner && owner.rows[0].role !== 'member')
        throw new ApiError(403, 'FORBIDDEN', 'You cannot remove this agent.');
      await client.query(
        'UPDATE agents SET active=false,revoked_at=now() WHERE id=$1 AND community_id=$2',
        [id, actor.community_id]
      );
      await client.query(
        'UPDATE agent_credentials SET revoked_at=now() WHERE agent_id=$1 AND community_id=$2 AND revoked_at IS NULL',
        [id, actor.community_id]
      );
      await client.query(
        'DELETE FROM agent_channel_members WHERE agent_id=$1 AND community_id=$2',
        [id, actor.community_id]
      );
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [actor.community_id, actor.id, 'agent.eject', id]
      );
    });
    return c.body(null, 204);
  });

  app.post('/channels/:id/agents', async (c) => {
    const grant = c.req.header('authorization')
      ? await requireConnectionGrant(c, pool, 'enroll-agent')
      : undefined;
    const actor = grant?.member ?? (await requireMember(c, auth, pool));
    const { agentId } = await readJson(c, CommunityWireAgentChannelMembershipRequestSchema);
    await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), actor);
      if (grant)
        await assertConnectionGrantCurrent(
          client,
          actor.id,
          grant.tokenHash,
          actor.community_id,
          'enroll-agent'
        );
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
        'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [actor.community_id, channel.id, agentId]
      );
    });
    return json(c, CommunityWireAgentChannelMembershipResponseSchema, { joined: true });
  });

  app.delete('/channels/:id/agents/:agentId', async (c) => {
    const grant = c.req.header('authorization')
      ? await requireConnectionGrant(c, pool, 'enroll-agent')
      : undefined;
    const actor = grant?.member ?? (await requireMember(c, auth, pool));
    const agentId = uuid.parse(c.req.param('agentId'));
    await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), actor);
      if (grant)
        await assertConnectionGrantCurrent(
          client,
          actor.id,
          grant.tokenHash,
          actor.community_id,
          'enroll-agent'
        );
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
