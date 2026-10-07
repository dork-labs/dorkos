import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireOpenAdmissionJoinRequestSchema,
  CommunityWireOpenAdmissionJoinResponseSchema,
  CommunityWireOpenAdmissionPreflightResponseSchema,
  CommunityWireOpenAdmissionSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { lockActiveCommunity, requireSessionUser, transaction } from '../../data.js';
import { ApiError, json, readJson } from '../../http.js';
import { assertMemberRoom } from '../../host/limits.js';
import { mintHandle } from '../../handles.js';
import { readmissionBlocked } from '../../erasure/guards.js';
import { OIDC_PROVIDER_ID } from '../../oidc.js';
import { signValue } from '../../security.js';
import { resolveCommunityContext } from '../../tenant-context.js';
import { bannedRefusal, isBanned } from '../../moderation/bans.js';
import { joinAutoJoinChannels, lockAutoJoinChannels } from '../../admission/auto-join.js';
import {
  OPEN_ADMISSION_COOKIE,
  OPEN_ADMISSION_MS,
  openAdmissionAvailable,
} from '../../admission/open-admission-cookie.js';
import { clearFormerMembership } from './members.js';

/** Refuse unless the community is active and open, and the host offers open admission. */
async function assertOpen(
  db: Pick<Pool | PoolClient, 'query'>,
  communityId: string,
  config: CommunityConfig,
  lock: boolean
): Promise<string> {
  const result = await db.query<{ admission_policy: string; name: string }>(
    `SELECT admission_policy,name FROM communities WHERE id=$1${lock ? ' FOR SHARE' : ''}`,
    [communityId]
  );
  const row = result.rows[0];
  if (!openAdmissionAvailable(config) || row?.admission_policy !== 'open')
    throw new ApiError(409, 'STATE_CONFLICT', 'This space needs an invitation to join.');
  return row.name;
}

/**
 * Register open admission: the public answer to "can I join here?", the preflight a sign-up
 * needs, and the join itself.
 *
 * A join admits only an account that signs in through the host's single sign-on service and
 * whose email that service verified: open admission never makes a password sign-up possible.
 * Joins are limited per caller and per host, and `COMMUNITY_OPEN_ADMISSION=0` refuses them all.
 */
export function registerOpenAdmissionRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    limitJoin,
  }: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    /** Spend one open-join attempt for this caller and for the host; throws `429` past either. */
    limitJoin: (c: Context) => void;
  }
): void {
  app.get('/open-admission', async (c) => {
    const tenant = await resolveCommunityContext(c, pool);
    const result = await pool.query<{ admission_policy: string; name: string }>(
      'SELECT admission_policy,name FROM communities WHERE id=$1',
      [tenant.communityId]
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Space not found.');
    return json(c, CommunityWireOpenAdmissionSchema, {
      open:
        openAdmissionAvailable(config) &&
        row.admission_policy === 'open' &&
        tenant.lifecycle === 'active',
      communityName: row.name,
    });
  });

  app.post('/open-admission/preflight', async (c) => {
    limitJoin(c);
    const tenant = await resolveCommunityContext(c, pool);
    await assertOpen(pool, tenant.communityId, config, false);
    const expiresAt = new Date(Date.now() + OPEN_ADMISSION_MS);
    setCookie(
      c,
      OPEN_ADMISSION_COOKIE,
      signValue(`${tenant.communityId}.${expiresAt.getTime()}`, config.authSecret),
      {
        httpOnly: true,
        sameSite: 'Lax',
        secure: config.publicUrl.startsWith('https:'),
        path: '/',
        maxAge: OPEN_ADMISSION_MS / 1000,
      }
    );
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireOpenAdmissionPreflightResponseSchema, {
      granted: true,
      expiresAt: expiresAt.toISOString(),
    });
  });

  app.post('/open-admission/join', async (c) => {
    await readJson(c, CommunityWireOpenAdmissionJoinRequestSchema);
    const user = await requireSessionUser(c, auth);
    limitJoin(c);
    const memberId = await transaction(pool, async (client) => {
      const tenant = await resolveCommunityContext(c, client);
      await lockActiveCommunity(client, tenant.communityId);
      await assertOpen(client, tenant.communityId, config, true);
      // Only an account the host's single sign-on vouches for, with an email it verified.
      const account = await client.query<{ email: string; verified: boolean; sso: boolean }>(
        `SELECT u.email,u."emailVerified" AS verified,
           EXISTS(SELECT 1 FROM account a WHERE a."userId"=u.id AND a."providerId"=$2) AS sso
         FROM "user" u WHERE u.id=$1 FOR SHARE`,
        [user.id, OIDC_PROVIDER_ID]
      );
      const found = account.rows[0];
      if (!found?.sso)
        throw new ApiError(
          403,
          'FORBIDDEN',
          `Sign in with ${config.oidc?.label ?? 'single sign-on'} to join this space.`
        );
      if (!found.verified)
        throw new ApiError(403, 'FORBIDDEN', 'Confirm your email before joining this space.');
      if (
        await isBanned(
          client,
          tenant.communityId,
          { userId: user.id, email: found.email },
          config.authSecret
        )
      )
        throw bannedRefusal();
      if (await readmissionBlocked(client, tenant.communityId, user.id))
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'This account is being erased here. Try again later.'
        );
      // Channels before any member row, as every channel write takes them (DOR-2277).
      const channels = await lockAutoJoinChannels(client, tenant.communityId);
      await assertMemberRoom(client, tenant.communityId, { lock: true, userId: user.id });
      let member = await client.query<{ id: string; active: boolean }>(
        'SELECT id,active FROM members WHERE community_id=$1 AND user_id=$2 FOR UPDATE',
        [tenant.communityId, user.id]
      );
      if (member.rows[0]?.active) return member.rows[0].id;
      if (!member.rows[0]) {
        const handle = await mintHandle(client, tenant.communityId, user.name);
        member = await client.query(
          "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,$2,$3,$4,'member') RETURNING id,active",
          [tenant.communityId, user.id, user.name, handle]
        );
        await client.query(
          'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
          [tenant.communityId, handle, member.rows[0].id]
        );
      } else {
        await clearFormerMembership(client, member.rows[0].id, tenant.communityId);
        await client.query(
          "UPDATE members SET active=true,removed_at=NULL,role='member' WHERE id=$1",
          [member.rows[0].id]
        );
      }
      const id = member.rows[0].id;
      await joinAutoJoinChannels(client, tenant.communityId, id, channels);
      // `next_state` records how the person came in: open admission, not an invitation.
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,next_state)
         VALUES($1,$2,'member.admit',$3,'open')`,
        [tenant.communityId, id, id]
      );
      return id;
    });
    deleteCookie(c, OPEN_ADMISSION_COOKIE, { path: '/' });
    return json(c, CommunityWireOpenAdmissionJoinResponseSchema, { memberId });
  });
}
