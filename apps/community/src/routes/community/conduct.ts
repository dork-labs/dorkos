import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  CommunityWireChannelSlowModeSchema,
  CommunityWireDisplayNameUpdateRequestSchema,
  CommunityWireMemberResponseSchema,
  CommunityWireMuteListResponseSchema,
  CommunityWireMuteRequestSchema,
  CommunityWireMuteResponseSchema,
  CommunityWireReservedNamesSchema,
  CommunityWireRulesAcceptRequestSchema,
  CommunityWireRulesSchema,
  CommunityWireRulesUpdateRequestSchema,
  CommunityWireStandingSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import {
  requireLiveRole,
  requireMember,
  requirePrincipal,
  assertPrincipalCurrent,
  transaction,
  type Member,
} from '../../data.js';
import { ApiError, json, readJson } from '../../http.js';
import { muteMember } from '../../moderation/mutes.js';
import { outranks } from '../../moderation/bans.js';
import { lockOwnMembership } from '../../moderation/locks.js';
import { comparableName, isRefusedDisplayName } from '../../moderation/display-names.js';

/**
 * Register a space's standards of conduct: mutes, the caller's own standing, rules and their
 * acceptance, reserved names, each member's own display name, and reading a channel's slow mode.
 * Slow mode is set through `PATCH /channels/:id` with the other channel settings.
 */
export function registerConductRoutes(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
): void {
  app.post('/members/:id/mute', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const targetId = z.uuid().parse(c.req.param('id'));
    const body = await readJson(c, CommunityWireMuteRequestSchema);
    const until = await transaction(pool, async (client) => {
      const role = await requireLiveRole(client, actor, ['owner', 'admin']);
      return muteMember(client, {
        actor: { id: actor.id, communityId: actor.community_id, role },
        targetId,
        minutes: body.minutes,
      });
    });
    return json(c, CommunityWireMuteResponseSchema, {
      memberId: targetId,
      mutedUntil: until.toISOString(),
    });
  });

  app.delete('/members/:id/mute', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const targetId = z.uuid().parse(c.req.param('id'));
    await transaction(pool, async (client) => {
      const role = await requireLiveRole(client, actor, ['owner', 'admin']);
      const target = await client.query<{ role: Member['role'] }>(
        'SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active FOR UPDATE',
        [targetId, actor.community_id]
      );
      if (!target.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
      if (!outranks(role, target.rows[0].role))
        throw new ApiError(403, 'FORBIDDEN', 'This member cannot be unmuted by your role.');
      const cleared = await client.query(
        'UPDATE members SET muted_until=NULL WHERE id=$1 AND muted_until>now() RETURNING id',
        [targetId]
      );
      if (cleared.rowCount)
        await client.query(
          `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,changed_fields)
           VALUES($1,$2,'member.unmute',$3,ARRAY['muted_until'])`,
          [actor.community_id, actor.id, targetId]
        );
    });
    return c.body(null, 204);
  });

  app.get('/mutes', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const rows = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin'], { allowHeld: true });
      return client.query<{
        id: string;
        display_name: string;
        handle: string;
        muted_until: Date;
      }>(
        `SELECT id,display_name,handle,muted_until FROM members
         WHERE community_id=$1 AND active AND muted_until>now() AND role<>'owner'
         ORDER BY muted_until,id LIMIT 500`,
        [actor.community_id]
      );
    });
    return json(c, CommunityWireMuteListResponseSchema, {
      mutes: rows.rows.map((row) => ({
        memberId: row.id,
        displayName: row.display_name,
        handle: row.handle,
        mutedUntil: row.muted_until.toISOString(),
      })),
    });
  });

  app.get('/me/standing', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const row = await pool.query<{ muted_until: Date | null }>(
      `SELECT CASE WHEN muted_until>now() AND role<>'owner' THEN muted_until END AS muted_until
       FROM members WHERE id=$1 AND community_id=$2`,
      [actor.id, actor.community_id]
    );
    return json(c, CommunityWireStandingSchema, {
      mutedUntil: row.rows[0]?.muted_until?.toISOString() ?? null,
    });
  });

  // Agents read the rules they post under; their owner's acceptance is the one that counts.
  app.get('/rules', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    const row = await pool.query<{
      rules_text: string | null;
      rules_version: number;
      accepted: number;
    }>(
      `SELECT c.rules_text,c.rules_version,m.rules_accepted_version AS accepted
       FROM communities c JOIN members m ON m.community_id=c.id
       WHERE c.id=$1 AND m.id=$2`,
      [principal.community_id, principal.ownerMemberId]
    );
    await assertPrincipalCurrent(c, auth, pool, principal, 'read');
    const rules = row.rows[0];
    if (!rules) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
    return json(c, CommunityWireRulesSchema, {
      text: rules.rules_text,
      version: rules.rules_version,
      acceptedVersion: rules.accepted,
    });
  });

  app.put('/rules', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireRulesUpdateRequestSchema);
    const result = await transaction(pool, async (client) => {
      const current = await client.query<{ rules_version: number }>(
        'SELECT rules_version FROM communities WHERE id=$1 FOR UPDATE',
        [actor.community_id]
      );
      await requireLiveRole(client, actor, ['owner', 'admin']);
      if (current.rows[0]?.rules_version !== body.expectedVersion)
        throw new ApiError(409, 'STATE_CONFLICT', 'The rules changed. Reload them, then edit.');
      // Every change, removal included, is a new version, so an old acceptance never covers it.
      const updated = await client.query<{ rules_version: number }>(
        `UPDATE communities SET rules_text=$2,rules_version=rules_version+1
         WHERE id=$1 RETURNING rules_version`,
        [actor.community_id, body.text]
      );
      const version = updated.rows[0].rules_version;
      // The editor accepts their own rules: they wrote them.
      await client.query(
        'UPDATE members SET rules_accepted_version=$2 WHERE id=$1 AND community_id=$3',
        [actor.id, version, actor.community_id]
      );
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,next_state,changed_fields)
         VALUES($1,$2,'rules.update',$3,ARRAY['rules_text','rules_version'])`,
        [actor.community_id, actor.id, String(version)]
      );
      return { text: body.text, version };
    });
    return json(c, CommunityWireRulesSchema, { ...result, acceptedVersion: result.version });
  });

  app.post('/rules/accept', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireRulesAcceptRequestSchema);
    const result = await transaction(pool, async (client) => {
      // Share, so an edit (FOR UPDATE) waits: nobody accepts a version as it is being replaced.
      const rules = await client.query<{ rules_text: string | null; rules_version: number }>(
        'SELECT rules_text,rules_version FROM communities WHERE id=$1 FOR SHARE',
        [actor.community_id]
      );
      await lockOwnMembership(client, actor);
      await requireLiveRole(client, actor, ['owner', 'admin', 'member'], { allowHeld: true });
      const current = rules.rows[0];
      if (!current?.rules_text || current.rules_version !== body.version)
        throw new ApiError(409, 'STATE_CONFLICT', 'The rules changed. Read them again first.');
      await client.query(
        'UPDATE members SET rules_accepted_version=$2 WHERE id=$1 AND community_id=$3',
        [actor.id, body.version, actor.community_id]
      );
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,next_state)
         VALUES($1,$2,'rules.accept',$3,$4)`,
        [actor.community_id, actor.id, actor.id, String(body.version)]
      );
      return current;
    });
    return json(c, CommunityWireRulesSchema, {
      text: result.rules_text,
      version: result.rules_version,
      acceptedVersion: result.rules_version,
    });
  });

  app.get('/reserved-names', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const rows = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin'], { allowHeld: true });
      return client.query<{ reserved_names: string[] }>(
        'SELECT reserved_names FROM communities WHERE id=$1',
        [actor.community_id]
      );
    });
    return json(c, CommunityWireReservedNamesSchema, {
      names: rows.rows[0]?.reserved_names ?? [],
    });
  });

  app.put('/reserved-names', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireReservedNamesSchema);
    const names = [...new Map(body.names.map((name) => [comparableName(name), name])).values()];
    await transaction(pool, async (client) => {
      // For update first: two saves at once queue, rather than each holding a share.
      await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [actor.community_id]);
      await requireLiveRole(client, actor, ['owner']);
      await client.query('UPDATE communities SET reserved_names=$2 WHERE id=$1', [
        actor.community_id,
        names,
      ]);
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,changed_fields)
         VALUES($1,$2,'settings.update',ARRAY['reserved_names'])`,
        [actor.community_id, actor.id]
      );
    });
    return json(c, CommunityWireReservedNamesSchema, { names });
  });

  app.patch('/me', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const { displayName } = await readJson(c, CommunityWireDisplayNameUpdateRequestSchema);
    const member = await transaction(pool, async (client) => {
      // The community's share, so a change to the reserved names (an update) waits for this
      // rename or this rename reads the new list; then the caller's own row, for update.
      await lockOwnMembership(client, actor);
      const role = await requireLiveRole(client, actor, ['owner', 'admin', 'member']);
      const staff = role === 'owner' || role === 'admin';
      const check = { staff, memberId: actor.id };
      if (await isRefusedDisplayName(client, actor.community_id, displayName, check))
        throw new ApiError(409, 'STATE_CONFLICT', 'That name is taken in this space. Try another.');
      const updated = await client.query<{
        id: string;
        display_name: string;
        handle: string;
        role: Member['role'];
        created_at: Date;
      }>(
        `UPDATE members SET display_name=$3 WHERE id=$1 AND community_id=$2
         RETURNING id,display_name,handle,role,created_at`,
        [actor.id, actor.community_id, displayName]
      );
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,changed_fields)
         VALUES($1,$2,'member.rename',$3,ARRAY['display_name'])`,
        [actor.community_id, actor.id, actor.id]
      );
      return updated.rows[0];
    });
    return json(c, CommunityWireMemberResponseSchema, {
      member: {
        memberId: member.id,
        kind: 'human',
        displayName: member.display_name,
        handle: member.handle,
        role: member.role,
        ownerMemberId: null,
        joinedAt: member.created_at.toISOString(),
      },
    });
  });

  app.get('/channels/:id/slow-mode', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    const channelId = z.uuid().safeParse(c.req.param('id'));
    if (!channelId.success) throw new ApiError(404, 'NOT_FOUND', 'Channel not found.');
    const agent = principal.kind === 'agent';
    // Readable exactly when the channel is: public to a member, joined for an agent or private.
    const row = await pool.query<{ slow_mode_seconds: number }>(
      `SELECT c.slow_mode_seconds FROM channels c
       WHERE c.id=$1 AND c.community_id=$2 AND (
         ${agent ? 'FALSE' : "c.visibility='public'"} OR EXISTS(
           SELECT 1 FROM ${agent ? 'agent_channel_members' : 'channel_members'} cm
           WHERE cm.channel_id=c.id AND cm.${agent ? 'agent_id' : 'member_id'}=$3))`,
      [channelId.data, principal.community_id, principal.id]
    );
    await assertPrincipalCurrent(c, auth, pool, principal, 'read');
    if (!row.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Channel not found.');
    return json(c, CommunityWireChannelSlowModeSchema, { seconds: row.rows[0].slow_mode_seconds });
  });
}
