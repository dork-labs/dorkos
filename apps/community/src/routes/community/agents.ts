import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityWireAgentEnrollRequestSchema,
  CommunityWireAgentListResponseSchema,
  CommunityWireAgentChannelMembershipRequestSchema,
  CommunityWireAgentChannelMembershipResponseSchema,
} from '@dorkos/shared/community-wire';
import { CommunityAgentEnrollmentSecretResponseSchema } from '@dorkos/shared/community-private-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import {
  assertConnectionGrantCurrent,
  lockChannel,
  requireConnectionGrant,
  requireLiveRole,
  requireMember,
  transaction,
  type Member,
} from '../../data.js';
import { mintHandle } from '../../handles.js';
import { ApiError, json, readJson } from '../../http.js';
import { agentLimitReached, effectiveAgentLimit } from '../../host/limits.js';
import { hashSecret, randomToken } from '../../security.js';

const uuid = z.uuid();
interface AgentRow {
  id: string;
  display_name: string;
  handle: string;
  owner_member_id: string;
  active: boolean;
}
interface ScopedAgentRow extends AgentRow {
  enrolled_by_grant_id: string | null;
  local_agent_id: string | null;
  /** Whether the grant making this request may act on the row (see {@link grantScope}). */
  in_scope: boolean;
}

/**
 * SQL that is true when a request made with the grant in `grantParam` may act on the agent row
 * aliased `alias`: the grant's own agent; a legacy one (NULL: enrolled before the Community
 * recorded grants, member-scoped as it always was); or an orphaned one, whose enrolling grant
 * was since revoked or deleted, so no installation holds it any more. The last is how an
 * installation that reconnects under a new grant gets its agent, handle and channels back. An
 * agent whose enrolling grant is still live belongs to another installation and is out of
 * scope. The caller also matches the agent's owner to the grant's member.
 */
function grantScope(alias: string, grantParam: string): string {
  return `(${alias}.enrolled_by_grant_id=${grantParam} OR ${alias}.enrolled_by_grant_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM connection_grants live WHERE live.id=${alias}.enrolled_by_grant_id
      AND live.community_id=${alias}.community_id AND live.revoked_at IS NULL))`;
}

/**
 * Give a legacy or orphaned agent to the grant now recovering, rotating or re-enrolling it. That
 * grant is about to hold the agent's only credential, so from here on it alone of the owner's
 * installations acts on it. An inactive row the grant already holds for the same local id loses
 * that local id, so the grant keeps one row per local id: the one being taken over, with its
 * handle and channels.
 */
async function adoptAgent(
  client: PoolClient,
  row: ScopedAgentRow,
  grantId: string,
  communityId: string
): Promise<void> {
  if (row.enrolled_by_grant_id === grantId) return;
  if (row.local_agent_id !== null)
    await client.query(
      `UPDATE agents SET local_agent_id=NULL WHERE community_id=$1 AND enrolled_by_grant_id=$2
       AND local_agent_id=$3 AND id<>$4 AND NOT active`,
      [communityId, grantId, row.local_agent_id, row.id]
    );
  await client.query('UPDATE agents SET enrolled_by_grant_id=$3 WHERE id=$1 AND community_id=$2', [
    row.id,
    communityId,
    grantId,
  ]);
}

const SCOPED_COLUMNS =
  'id,display_name,handle,owner_member_id,active,enrolled_by_grant_id,local_agent_id';

/** Whether a grant of `memberId` may act on this agent: in the grant's scope, and its member's. */
function grantActsOn(row: { owner_member_id: string; in_scope: boolean }, memberId: string) {
  return row.in_scope && row.owner_member_id === memberId;
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
      // Every row for this local id, whichever installation enrolled it. Two installations of
      // one person share local ids (they are committed with the agent), and each gets its own
      // agent here, so only a row in this grant's scope counts as already enrolled.
      const existing = await client.query<ScopedAgentRow>(
        `SELECT ${SCOPED_COLUMNS},${grantScope('agents', '$4')} AS in_scope FROM agents
         WHERE owner_member_id=$1 AND community_id=$2 AND local_agent_id=$3
         ORDER BY created_at,id FOR UPDATE`,
        [member.id, member.community_id, body.localAgentId, member.grant_id]
      );
      if (existing.rows.some((row) => row.active && row.in_scope))
        throw new ApiError(409, 'STATE_CONFLICT', 'This local agent is already enrolled.');
      // An inactive row runs for no one, so reusing it takes nothing from anyone and keeps its
      // handle across a disconnect and reconnect: this grant's own first, then a legacy or
      // orphaned one, then one another installation let go. An active row of another live grant
      // is never touched.
      const inactive = existing.rows.filter((row) => !row.active);
      const reusable =
        inactive.find((row) => row.enrolled_by_grant_id === member.grant_id) ??
        inactive.find((row) => row.in_scope) ??
        inactive[0];
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
      if (reusable) await adoptAgent(client, reusable, member.grant_id, member.community_id);
      const agent = reusable
        ? await client.query<AgentRow>(
            'UPDATE agents SET active=true,revoked_at=NULL,display_name=$3 WHERE id=$1 AND community_id=$2 RETURNING id,display_name,handle,owner_member_id,active',
            [reusable.id, member.community_id, body.displayName]
          )
        : await (async () => {
            const handle =
              body.handle ?? (await mintHandle(client, member.community_id, body.displayName));
            const created = await client.query<AgentRow>(
              'INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id,enrolled_by_grant_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,display_name,handle,owner_member_id,active',
              [
                member.community_id,
                member.id,
                body.displayName,
                handle,
                body.localAgentId,
                member.grant_id,
              ]
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
    // Listing is read-only, so a kept grant can still see its agents while the host holds.
    const grant = c.req.header('authorization')
      ? await requireConnectionGrant(c, pool, 'enroll-agent', { allowHeld: true })
      : undefined;
    const actor = grant?.member ?? (await requireMember(c, auth, pool));
    // A person sees all their agents; an installation sees the ones in its scope (see grantScope).
    const rows = await pool.query<AgentRow>(
      `SELECT id,display_name,handle,owner_member_id,active FROM agents
       WHERE community_id=$1 AND owner_member_id=$2 AND active
         AND ($3::uuid IS NULL OR ${grantScope('agents', '$3')})
       ORDER BY created_at,id`,
      [actor.community_id, actor.id, grant?.member.grant_id ?? null]
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
      // Only an agent in this grant's scope: recovering one another live installation runs would
      // revoke the credential it is running on. That installation's agent is simply not found,
      // and the caller enrolls one of its own. An orphaned one (its grant revoked, as when an
      // installation reconnects) comes back with its handle and channels.
      const agent = await client.query<ScopedAgentRow>(
        `SELECT ${SCOPED_COLUMNS},true AS in_scope FROM agents
         WHERE owner_member_id=$1 AND community_id=$2 AND local_agent_id=$3 AND active
           AND ${grantScope('agents', '$4')}
         ORDER BY enrolled_by_grant_id IS DISTINCT FROM $4,created_at,id FOR UPDATE`,
        [member.id, member.community_id, body.localAgentId, member.grant_id]
      );
      if (!agent.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Active agent not found.');
      await adoptAgent(client, agent.rows[0], member.grant_id, member.community_id);
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
      const agent = await client.query<ScopedAgentRow>(
        `SELECT ${SCOPED_COLUMNS},true AS in_scope FROM agents
         WHERE id=$1 AND owner_member_id=$2 AND community_id=$3 AND active
           AND ${grantScope('agents', '$4')} FOR UPDATE`,
        [id, member.id, member.community_id, member.grant_id]
      );
      if (!agent.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      await adoptAgent(client, agent.rows[0], member.grant_id, member.community_id);
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
  //
  // A grant can remove only an agent in its scope (its own, a legacy one, or an orphaned one of
  // its member's; see grantScope): another live installation's agent, even the same person's,
  // is not found. The person, signed in to the
  // Community's own pages, can always remove any of their agents, and moderators remove what
  // they could before; that path never reads the enrolling grant, so an agent whose grant was
  // revoked, or whose owner handed the community on, stays removable there.
  app.delete('/agents/:id', async (c) => {
    const grant = c.req.header('authorization')
      ? await requireConnectionGrant(c, pool, 'enroll-agent', { allowHeld: true })
      : undefined;
    const actor = grant?.member ?? (await requireMember(c, auth, pool));
    const grantId = grant?.member.grant_id ?? null;
    const id = uuid.parse(c.req.param('id'));
    // A grant never moderates, so it has no early refusal: anything not its own is not found.
    if (!grant) {
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
      const candidate = await client.query<{
        owner_member_id: string;
        owner_role: Member['role'];
        in_scope: boolean;
      }>(
        `SELECT a.owner_member_id,m.role AS owner_role,${grantScope('a', '$3::uuid')} AS in_scope
         FROM agents a JOIN members m ON m.id=a.owner_member_id
         WHERE a.id=$1 AND a.community_id=$2 AND a.active AND m.active`,
        [id, actor.community_id, grantId]
      );
      const found = candidate.rows[0];
      if (!found || (grantId && !grantActsOn(found, actor.id)))
        throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
      const isOtherMember = found.owner_member_id !== actor.id;
      if (
        isOtherMember &&
        (role === 'member' || (role === 'admin' && found.owner_role !== 'member'))
      )
        throw new ApiError(403, 'FORBIDDEN', 'You cannot remove this agent.');
      // Only a moderator ejecting another ordinary member needs the target owner
      // lock. An admin checking an owner would invert owner-transfer's O→A order.
      // Early denial above is conservative if a concurrent demotion is pending.
      const owner =
        role === 'admin' && isOtherMember
          ? await client.query<{ role: Member['role'] }>(
              'SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
              [found.owner_member_id, actor.community_id]
            )
          : null;
      const target = await client.query<{
        id: string;
        owner_member_id: string;
        in_scope: boolean;
      }>(
        `SELECT a.id,a.owner_member_id,${grantScope('a', '$3::uuid')} AS in_scope
         FROM agents a WHERE a.id=$1 AND a.community_id=$2 AND a.active FOR UPDATE`,
        [id, actor.community_id, grantId]
      );
      const row = target.rows[0];
      // Recheck under the row lock: another installation may have taken the agent over since.
      if (
        !row ||
        row.owner_member_id !== found.owner_member_id ||
        (grantId && !grantActsOn(row, actor.id)) ||
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
      const agent = await client.query<{ owner_member_id: string; in_scope: boolean }>(
        `SELECT a.owner_member_id,${grantScope('a', '$3::uuid')} AS in_scope FROM agents a
         WHERE a.id=$1 AND a.community_id=$2 AND a.active FOR SHARE`,
        [agentId, actor.community_id, grant?.member.grant_id ?? null]
      );
      // A grant places only agents in its scope, like every other grant request; it never
      // moderates, so another installation's agent is not found.
      if (!agent.rows[0] || (grant && !grantActsOn(agent.rows[0], actor.id)))
        throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
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
      const agent = await client.query<{ owner_member_id: string; in_scope: boolean }>(
        `SELECT a.owner_member_id,${grantScope('a', '$3::uuid')} AS in_scope FROM agents a
         WHERE a.id=$1 AND a.community_id=$2 AND a.active FOR SHARE`,
        [agentId, actor.community_id, grant?.member.grant_id ?? null]
      );
      // A grant places only agents in its scope, like every other grant request; it never
      // moderates, so another installation's agent is not found.
      if (!agent.rows[0] || (grant && !grantActsOn(agent.rows[0], actor.id)))
        throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
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
