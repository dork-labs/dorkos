import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireInviteCreateRequestSchema,
  CommunityWireInviteCreateResponseSchema,
  CommunityWireInviteListResponseSchema,
  CommunityWireInvitePreflightResponseSchema,
  CommunityWireInvitePreviewResponseSchema,
  CommunityWireInviteRedeemResponseSchema,
  CommunityWireInviteSchema,
  CommunityWireInviteTokenRequestSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import {
  lockActiveCommunity,
  lockChannel,
  requireLiveRole,
  requireMember,
  requireSessionUser,
  transaction,
} from '../data.js';
import { ApiError, json, readJson } from '../http.js';
import { inspectInvite, issueInvite } from '../invites.js';
import { hashSecret, randomToken, readCookie, signValue, verifyValue } from '../security.js';
import { mintHandle } from '../handles.js';
import { resolveCommunityContext } from '../tenant-context.js';

interface InviteRow {
  id: string;
  community_id: string;
  issuer_member_id: string;
  channel_id: string | null;
  token_hash: string;
  seat_limit: number;
  use_count: number;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

function projection(row: InviteRow) {
  return CommunityWireInviteSchema.parse({
    id: row.id,
    channelId: row.channel_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    seats: row.seat_limit,
    uses: row.use_count,
    revoked: Boolean(row.revoked_at),
  });
}

async function validInvite(
  c: Context,
  client: PoolClient | Pool,
  token: string,
  config: CommunityConfig,
  lock = false
) {
  const tenant = await resolveCommunityContext(c, client);
  if (lock) await lockActiveCommunity(client as PoolClient, tenant.communityId);
  const community = await client.query<{ id: string; name: string }>(
    'SELECT id,name FROM communities WHERE id=$1',
    [tenant.communityId]
  );
  const communityId = community.rows[0]?.id;
  if (!communityId) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
  const signed = inspectInvite(token, communityId, config);
  if (!signed) throw new ApiError(403, 'FORBIDDEN', 'This invitation is invalid or expired.');
  if (lock) {
    const issuer = await client.query<{ issuer_member_id: string }>(
      'SELECT issuer_member_id FROM invites WHERE id=$1 AND community_id=$2',
      [signed.id, communityId]
    );
    if (!issuer.rows[0])
      throw new ApiError(403, 'FORBIDDEN', 'This invitation is invalid or expired.');
    // Issuer authority is stable until this transaction commits; role changes take its row lock.
    await client.query('SELECT 1 FROM members WHERE id=$1 AND community_id=$2 FOR SHARE', [
      issuer.rows[0].issuer_member_id,
      communityId,
    ]);
  }
  const result = await client.query<
    InviteRow & { issuer_name: string; channel_name: string | null }
  >(
    `SELECT i.*,m.display_name AS issuer_name,c.name AS channel_name
     FROM invites i JOIN members m ON m.id=i.issuer_member_id
     LEFT JOIN channels c ON c.id=i.channel_id
     WHERE i.id=$1 AND i.community_id=$2 AND m.active AND m.role IN ('owner','admin')
       AND i.token_hash=$3 AND i.expires_at>now() AND i.revoked_at IS NULL
     ${lock ? 'FOR UPDATE OF i' : ''}`,
    [signed.id, communityId, hashSecret(token)]
  );
  const invite = result.rows[0];
  if (!invite || signed.expiresAt.getTime() !== invite.expires_at.getTime()) {
    throw new ApiError(403, 'FORBIDDEN', 'This invitation is invalid or expired.');
  }
  return { invite, communityName: community.rows[0].name };
}

/** Register signed invite issuance, preview, preflight, revocation and atomic redemption. */
export function registerInviteRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    limitPreview,
  }: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    limitPreview: (c: Context) => void;
  }
) {
  app.post('/invites', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireInviteCreateRequestSchema);
    const result = await transaction(pool, async (client) => {
      if (body.channelId) await lockChannel(client, body.channelId, actor);
      await requireLiveRole(client, actor, ['owner', 'admin']);
      const id = randomUUID();
      const expiry = new Date(Date.now() + (body.expiresInDays ?? 7) * 86_400_000);
      const token = issueInvite(id, actor.community_id, expiry, config);
      const inserted = await client.query<InviteRow>(
        `INSERT INTO invites(id,community_id,issuer_member_id,channel_id,token_hash,seat_limit,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          id,
          actor.community_id,
          actor.id,
          body.channelId ?? null,
          hashSecret(token),
          body.seats ?? 1,
          expiry,
        ]
      );
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [actor.community_id, actor.id, 'invite.create', id]
      );
      return { invite: projection(inserted.rows[0]), token };
    });
    return json(c, CommunityWireInviteCreateResponseSchema, result, 201);
  });

  app.get('/invites', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const invites = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin']);
      const result = await client.query<InviteRow>(
        'SELECT * FROM invites WHERE community_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
        [actor.community_id]
      );
      return result.rows.map(projection);
    });
    return json(c, CommunityWireInviteListResponseSchema, { invites });
  });

  app.delete('/invites/:id', async (c) => {
    const actor = await requireMember(c, auth, pool);
    await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin']);
      const updated = await client.query(
        'UPDATE invites SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND community_id=$2 RETURNING id',
        [c.req.param('id'), actor.community_id]
      );
      if (!updated.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Invitation not found.');
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [actor.community_id, actor.id, 'invite.revoke', c.req.param('id')]
      );
    });
    return c.body(null, 204);
  });

  app.post('/invites/preview', async (c) => {
    limitPreview(c);
    const { token } = await readJson(c, CommunityWireInviteTokenRequestSchema);
    const { invite, communityName } = await validInvite(c, pool, token, config);
    if (invite.use_count >= invite.seat_limit)
      throw new ApiError(409, 'STATE_CONFLICT', 'This invitation has no seats left.');
    return json(c, CommunityWireInvitePreviewResponseSchema, {
      communityName,
      inviterName: invite.issuer_name,
      channelName: invite.channel_name,
    });
  });

  app.post('/invites/preflight', async (c) => {
    const { token } = await readJson(c, CommunityWireInviteTokenRequestSchema);
    const pending = randomToken();
    await transaction(pool, async (client) => {
      const { invite } = await validInvite(c, client, token, config, true);
      if (invite.use_count >= invite.seat_limit)
        throw new ApiError(409, 'STATE_CONFLICT', 'This invitation has no seats left.');
      await client.query(
        'INSERT INTO pending_admissions(community_id,invite_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
        [invite.community_id, invite.id, hashSecret(pending), new Date(Date.now() + 600_000)]
      );
    });
    setCookie(c, 'community_admission', signValue(pending, config.authSecret), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.publicUrl.startsWith('https:'),
      path: '/',
      maxAge: 600,
    });
    return json(c, CommunityWireInvitePreflightResponseSchema, { granted: true });
  });

  app.post('/invites/redeem', async (c) => {
    const { token } = await readJson(c, CommunityWireInviteTokenRequestSchema);
    const user = await requireSessionUser(c, auth);
    const pending = verifyValue(
      readCookie(c.req.header('cookie') ?? null, 'community_admission'),
      config.authSecret
    );
    if (!pending) throw new ApiError(403, 'FORBIDDEN', 'Start with an invitation before joining.');
    const memberId = await transaction(pool, async (client) => {
      const { invite } = await validInvite(c, client, token, config, true);
      const previous = await client.query(
        'SELECT 1 FROM invite_uses WHERE invite_id=$1 AND user_id=$2',
        [invite.id, user.id]
      );
      if (previous.rowCount) {
        const admitted = await client.query<{ id: string }>(
          'SELECT id FROM members WHERE user_id=$1 AND community_id=$2 AND active',
          [user.id, invite.community_id]
        );
        if (admitted.rows[0]) return admitted.rows[0].id;
      }
      const grant = await client.query<{ id: string }>(
        'SELECT id FROM pending_admissions WHERE invite_id=$1 AND token_hash=$2 AND expires_at>now() FOR UPDATE',
        [invite.id, hashSecret(pending)]
      );
      if (!grant.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'This join attempt has expired.');
      if (!previous.rowCount && invite.use_count >= invite.seat_limit)
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'This invitation has no seats left. Ask for a new link.'
        );
      let member = await client.query<{ id: string; active: boolean }>(
        'SELECT id,active FROM members WHERE community_id=$1 AND user_id=$2 FOR UPDATE',
        [invite.community_id, user.id]
      );
      if (!member.rows[0]) {
        const handle = await mintHandle(client, invite.community_id, user.name);
        member = await client.query(
          'INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,$2,$3,$4,$5) RETURNING id,active',
          [invite.community_id, user.id, user.name, handle, 'member']
        );
        await client.query(
          'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
          [invite.community_id, handle, member.rows[0].id]
        );
      } else if (!member.rows[0].active) {
        await client.query(
          "UPDATE members SET active=true,removed_at=NULL,role='member' WHERE id=$1",
          [member.rows[0].id]
        );
      }
      if (invite.channel_id)
        await client.query(
          'INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [invite.community_id, invite.channel_id, member.rows[0].id]
        );
      if (!previous.rowCount) {
        await client.query(
          'INSERT INTO invite_uses(community_id,invite_id,user_id) VALUES($1,$2,$3)',
          [invite.community_id, invite.id, user.id]
        );
        await client.query('UPDATE invites SET use_count=use_count+1 WHERE id=$1', [invite.id]);
      }
      await client.query('DELETE FROM pending_admissions WHERE id=$1', [grant.rows[0].id]);
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [invite.community_id, member.rows[0].id, 'member.admit', invite.id]
      );
      return member.rows[0].id;
    });
    return json(c, CommunityWireInviteRedeemResponseSchema, { memberId });
  });
}
