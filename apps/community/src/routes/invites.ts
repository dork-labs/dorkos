import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireInviteCreateRequestSchema,
  CommunityWireInviteCreateResponseSchema,
  CommunityWireInviteBindResponseSchema,
  CommunityWireInviteListResponseSchema,
  CommunityWireInvitePendingResponseSchema,
  CommunityWireInvitePreflightResponseSchema,
  CommunityWireInvitePreviewResponseSchema,
  CommunityWireInviteRedeemResponseSchema,
  CommunityWireInviteRedeemRequestSchema,
  CommunityWireInviteSchema,
  CommunityWireInviteTokenRequestSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import {
  communityHeld,
  lockActiveCommunity,
  lockChannel,
  requireLiveRole,
  requireMember,
  requireSessionUser,
  transaction,
} from '../data.js';
import { ApiError, json, readJson } from '../http.js';
import { assertMemberRoom } from '../host/limits.js';
import { inspectInvite, issueInvite } from '../invites.js';
import { hashSecret, randomToken, readCookie, signValue, verifyValue } from '../security.js';
import { mintHandle } from '../handles.js';
import { readmissionBlocked } from '../erasure/guards.js';
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

function invalidInvitation(): ApiError {
  return new ApiError(403, 'FORBIDDEN', 'This invitation cannot be used. Ask for a new link.');
}

/** A closed community admits no one new; existing members are unaffected. */
class AdmissionClosed extends ApiError {
  constructor() {
    super(409, 'STATE_CONFLICT', 'This community is closed to new members.');
  }
}

/**
 * Refuse new admission while the owner has closed the community. The write paths call this
 * after `lockActiveCommunity` has taken the community row in share mode in the same
 * transaction; that lock is what serializes them with the settings update that closes
 * admission (it takes the row for update, then revokes every invitation), so an invitation or
 * admission either commits first and is revoked by the close, or reads `closed` here. With
 * `lock` the read also takes that share lock itself, so it stays correct for any caller; the
 * read-only preview reads without it.
 */
async function assertAdmissionOpen(
  client: PoolClient | Pool,
  communityId: string,
  lock: boolean
): Promise<void> {
  const result = await client.query<{ admission_policy: string }>(
    `SELECT admission_policy FROM communities WHERE id=$1${lock ? ' FOR SHARE' : ''}`,
    [communityId]
  );
  if (result.rows[0]?.admission_policy === 'closed') throw new AdmissionClosed();
}

/**
 * Keep the closed, full, and held reasons visible, so a person learns before signing up that
 * they cannot join yet; hide every other invitation failure. Each is reached only after the
 * link's signature checks out.
 */
function invitationRefusal(error: ApiError): ApiError {
  return error instanceof AdmissionClosed ||
    error.code === 'MEMBER_LIMIT_REACHED' ||
    error.code === 'COMMUNITY_HELD'
    ? error
    : invalidInvitation();
}

/**
 * The account already signed in on this browser, if any. An invitation to a full community
 * still opens for someone who is already an active member, who takes no new seat.
 */
async function signedInUserId(c: Context, auth: CommunityAuth): Promise<string | undefined> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  return session?.user.id;
}

function admissionCookie(c: Context, config: CommunityConfig): string {
  const value = verifyValue(
    readCookie(c.req.header('cookie') ?? null, 'community_admission'),
    config.authSecret
  );
  if (!value) throw new ApiError(403, 'FORBIDDEN', 'Start with an invitation before joining.');
  return value;
}

/** Delete one bounded batch of expired admission transactions and their cascading receipts. */
export async function sweepExpiredAdmissions(pool: Pool, batchSize = 100): Promise<number> {
  const result = await pool.query(
    `WITH expired AS (
       SELECT id FROM pending_admissions
       WHERE expires_at<=now()
       ORDER BY expires_at,id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM pending_admissions p USING expired
     WHERE p.id=expired.id
     RETURNING p.id`,
    [batchSize]
  );
  return result.rowCount ?? 0;
}

async function validInvite(
  c: Context,
  client: PoolClient | Pool,
  token: string,
  config: CommunityConfig,
  lock = false
) {
  const tenant = await resolveCommunityContext(c, client);
  const community = await client.query<{ id: string; name: string }>(
    'SELECT id,name FROM communities WHERE id=$1',
    [tenant.communityId]
  );
  const communityId = community.rows[0]?.id;
  if (!communityId) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
  const signed = inspectInvite(token, communityId, config);
  if (!signed) throw new ApiError(403, 'FORBIDDEN', 'This invitation is invalid or expired.');
  // After the signature, so only a genuine link learns the community is on hold. A hold keeps
  // the invitation: it waits, and works after release if it has not expired.
  if (lock) await lockActiveCommunity(client as PoolClient, communityId);
  // Only a link genuinely signed for this community learns that it is closed; a made-up token
  // gets the same public failure whether the community is open or closed.
  await assertAdmissionOpen(client, communityId, lock);
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
  return { invite, communityName: community.rows[0].name, held: tenant.lifecycle === 'held' };
}

/** Register signed invite issuance, preview, preflight, revocation and atomic redemption. */
export function registerInviteRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    limitPreviewPeer,
    limitPreviewIdentity,
  }: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    limitPreviewPeer: (c: Context) => void;
    limitPreviewIdentity: (token: string) => void;
  }
) {
  app.post('/invites', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireInviteCreateRequestSchema);
    const result = await transaction(pool, async (client) => {
      if (body.channelId) await lockChannel(client, body.channelId, actor);
      await requireLiveRole(client, actor, ['owner', 'admin']);
      await assertAdmissionOpen(client, actor.community_id, true);
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
      // A hold keeps invitations; reading and revoking them is not growth.
      await requireLiveRole(client, actor, ['owner', 'admin'], { allowHeld: true });
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
      await requireLiveRole(client, actor, ['owner', 'admin'], { allowHeld: true });
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
    limitPreviewPeer(c);
    const { token } = await readJson(c, CommunityWireInviteTokenRequestSchema);
    limitPreviewIdentity(token);
    try {
      const { invite, communityName, held } = await validInvite(c, pool, token, config);
      if (invite.use_count >= invite.seat_limit) throw invalidInvitation();
      await assertMemberRoom(pool, invite.community_id, {
        lock: false,
        userId: await signedInUserId(c, auth),
      });
      return json(c, CommunityWireInvitePreviewResponseSchema, {
        communityName,
        inviterName: invite.issuer_name,
        channelName: invite.channel_name,
        held,
      });
    } catch (error) {
      if (error instanceof ApiError) throw invitationRefusal(error);
      throw error;
    }
  });

  app.post('/invites/preflight', async (c) => {
    limitPreviewPeer(c);
    const { token } = await readJson(c, CommunityWireInviteTokenRequestSchema);
    limitPreviewIdentity(token);
    const pending = randomToken();
    const expiresAt = new Date(Date.now() + 600_000);
    let preview: { communityName: string; inviterName: string; channelName: string | null };
    try {
      preview = await transaction(pool, async (client) => {
        const { invite, communityName } = await validInvite(c, client, token, config, true);
        if (invite.use_count >= invite.seat_limit) throw invalidInvitation();
        await assertMemberRoom(client, invite.community_id, {
          lock: false,
          userId: await signedInUserId(c, auth),
        });
        await client.query(
          'INSERT INTO pending_admissions(community_id,invite_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
          [invite.community_id, invite.id, hashSecret(pending), expiresAt]
        );
        return {
          communityName,
          inviterName: invite.issuer_name,
          channelName: invite.channel_name,
        };
      });
    } catch (error) {
      if (error instanceof ApiError) throw invitationRefusal(error);
      throw error;
    }
    setCookie(c, 'community_admission', signValue(pending, config.authSecret), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.publicUrl.startsWith('https:'),
      path: '/',
      maxAge: 600,
    });
    return json(c, CommunityWireInvitePreflightResponseSchema, {
      granted: true,
      expiresAt: expiresAt.toISOString(),
      ...preview,
    });
  });

  // A reload or sign-in callback lands on the clean join URL with only the HttpOnly admission
  // cookie. Reading it back keeps the review on screen without ever returning the invitation.
  // It applies the same liveness conditions as bind, so a revoked invitation or a departed
  // issuer ends the review here too, and it never writes. The tenant-scoped lookup runs first:
  // a cookie from another community gets the same refusal as no cookie, and learns nothing
  // about this one, not even that it is closed.
  app.get('/invites/pending', async (c) => {
    c.header('Cache-Control', 'no-store');
    const pending = admissionCookie(c, config);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const tenant = await resolveCommunityContext(c, pool);
    // A hold pauses every join attempt without ending it: say why, and the same attempt
    // completes after release if it has not expired.
    if (tenant.lifecycle === 'held') throw communityHeld();
    const result = await pool.query<{
      expires_at: Date;
      account_id: string | null;
      community_name: string;
      inviter_name: string;
      channel_name: string | null;
    }>(
      `SELECT p.expires_at,p.account_id,community.name AS community_name,
              issuer.display_name AS inviter_name,channel.name AS channel_name
       FROM pending_admissions p
       JOIN communities community ON community.id=p.community_id
       JOIN invites i ON i.id=p.invite_id AND i.community_id=p.community_id
       JOIN members issuer ON issuer.id=i.issuer_member_id AND issuer.community_id=i.community_id
       LEFT JOIN channels channel ON channel.id=i.channel_id AND channel.community_id=i.community_id
       WHERE p.community_id=$1 AND p.token_hash=$2 AND p.expires_at>now() AND p.consumed_at IS NULL
         AND community.lifecycle='active' AND i.expires_at>now() AND i.revoked_at IS NULL
         AND issuer.active AND issuer.role IN ('owner','admin')`,
      [tenant.communityId, hashSecret(pending)]
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(403, 'FORBIDDEN', 'This join attempt has expired.');
    await assertAdmissionOpen(pool, tenant.communityId, false);
    let account: {
      membership: 'none' | 'active' | 'inactive';
      boundToAnotherAccount: boolean;
    } | null = null;
    if (session) {
      const member = await pool.query<{ active: boolean }>(
        'SELECT active FROM members WHERE community_id=$1 AND user_id=$2',
        [tenant.communityId, session.user.id]
      );
      const found = member.rows[0];
      account = {
        membership: !found ? 'none' : found.active ? 'active' : 'inactive',
        // Binding would refuse this account, so the page says why instead of trying.
        boundToAnotherAccount: row.account_id !== null && row.account_id !== session.user.id,
      };
    }
    return json(c, CommunityWireInvitePendingResponseSchema, {
      expiresAt: row.expires_at.toISOString(),
      communityName: row.community_name,
      inviterName: row.inviter_name,
      channelName: row.channel_name,
      account,
    });
  });

  app.post('/invites/bind', async (c) => {
    const user = await requireSessionUser(c, auth);
    const pending = admissionCookie(c, config);
    await transaction(pool, async (client) => {
      const tenant = await resolveCommunityContext(c, client);
      await lockActiveCommunity(client, tenant.communityId);
      await assertAdmissionOpen(client, tenant.communityId, true);
      const result = await client.query<{ account_id: string | null }>(
        `SELECT p.account_id FROM pending_admissions p
         JOIN invites i ON i.id=p.invite_id AND i.community_id=p.community_id
         JOIN members issuer ON issuer.id=i.issuer_member_id AND issuer.community_id=i.community_id
         WHERE p.community_id=$1 AND p.token_hash=$2 AND p.expires_at>now()
           AND i.expires_at>now() AND i.revoked_at IS NULL
           AND issuer.active AND issuer.role IN ('owner','admin')
         FOR UPDATE OF p`,
        [tenant.communityId, hashSecret(pending)]
      );
      const row = result.rows[0];
      if (!row) throw new ApiError(403, 'FORBIDDEN', 'This join attempt has expired.');
      if (row.account_id && row.account_id !== user.id)
        throw new ApiError(403, 'FORBIDDEN', 'This join attempt belongs to another account.');
      if (!row.account_id)
        await client.query(
          'UPDATE pending_admissions SET account_id=$1,bound_at=now() WHERE token_hash=$2',
          [user.id, hashSecret(pending)]
        );
    });
    return json(c, CommunityWireInviteBindResponseSchema, { bound: true });
  });

  app.post('/invites/redeem', async (c) => {
    await readJson(c, CommunityWireInviteRedeemRequestSchema);
    const user = await requireSessionUser(c, auth);
    const pending = admissionCookie(c, config);
    const memberId = await transaction(pool, async (client) => {
      const tenant = await resolveCommunityContext(c, client);
      await lockActiveCommunity(client, tenant.communityId);
      await assertAdmissionOpen(client, tenant.communityId, true);
      const admission = await client.query<{
        id: string;
        community_id: string;
        invite_id: string;
        account_id: string | null;
        consumed_at: Date | null;
        member_id: string | null;
        member_active: boolean | null;
      }>(
        `SELECT p.id,p.community_id,p.invite_id,p.account_id,p.consumed_at,r.member_id,
                receipt_member.active AS member_active
         FROM pending_admissions p
         LEFT JOIN admission_receipts r ON r.admission_id=p.id AND r.community_id=p.community_id
         LEFT JOIN members receipt_member
           ON receipt_member.id=r.member_id AND receipt_member.community_id=r.community_id
         WHERE p.community_id=$1 AND p.token_hash=$2 AND p.expires_at>now()
         FOR UPDATE OF p`,
        [tenant.communityId, hashSecret(pending)]
      );
      const grant = admission.rows[0];
      if (!grant) throw new ApiError(403, 'FORBIDDEN', 'This join attempt has expired.');
      if (!grant.account_id || grant.account_id !== user.id)
        throw new ApiError(403, 'FORBIDDEN', 'This join attempt is not bound to this account.');
      if (grant.consumed_at) {
        if (!grant.member_id || !grant.member_active)
          throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
        return grant.member_id;
      }
      // Reactivating the member row mid-erasure would bring the person back while their data
      // is being removed; the erasure's seal would then have to remove them again.
      if (await readmissionBlocked(client, tenant.communityId, user.id))
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'This account is being erased here. Try again later.'
        );
      const inviteResult = await client.query<InviteRow>(
        `SELECT i.* FROM invites i
         JOIN members issuer ON issuer.id=i.issuer_member_id AND issuer.community_id=i.community_id
         WHERE i.id=$1 AND i.community_id=$2 AND i.expires_at>now() AND i.revoked_at IS NULL
           AND issuer.active AND issuer.role IN ('owner','admin')
         FOR UPDATE OF i,issuer`,
        [grant.invite_id, grant.community_id]
      );
      const invite = inviteResult.rows[0];
      if (!invite) throw invalidInvitation();
      const previous = await client.query(
        'SELECT 1 FROM invite_uses WHERE invite_id=$1 AND user_id=$2',
        [invite.id, user.id]
      );
      if (!previous.rowCount && invite.use_count >= invite.seat_limit)
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'This invitation has no seats left. Ask for a new link.'
        );
      // After the invite lock, before any insert or reactivation: the limit row lock serializes
      // admissions racing for the last seat, and an active member is not counted twice.
      await assertMemberRoom(client, invite.community_id, { lock: true, userId: user.id });
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
        await client.query('DELETE FROM channel_members WHERE member_id=$1 AND community_id=$2', [
          member.rows[0].id,
          invite.community_id,
        ]);
        await client.query('DELETE FROM read_cursors WHERE member_id=$1 AND community_id=$2', [
          member.rows[0].id,
          invite.community_id,
        ]);
        await client.query(
          'UPDATE connection_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE member_id=$1 AND community_id=$2',
          [member.rows[0].id, invite.community_id]
        );
        await client.query(
          'UPDATE connection_pairings SET cancelled_at=COALESCE(cancelled_at,now()) WHERE member_id=$1 AND community_id=$2 AND consumed_at IS NULL',
          [member.rows[0].id, invite.community_id]
        );
        await client.query(
          `DELETE FROM agent_channel_members
           WHERE community_id=$2 AND agent_id IN
             (SELECT id FROM agents WHERE owner_member_id=$1 AND community_id=$2)`,
          [member.rows[0].id, invite.community_id]
        );
        await client.query(
          'UPDATE agents SET active=false,revoked_at=COALESCE(revoked_at,now()) WHERE owner_member_id=$1 AND community_id=$2',
          [member.rows[0].id, invite.community_id]
        );
        await client.query(
          `UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at,now())
           WHERE community_id=$2 AND agent_id IN
             (SELECT id FROM agents WHERE owner_member_id=$1 AND community_id=$2)`,
          [member.rows[0].id, invite.community_id]
        );
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
      await client.query(
        `INSERT INTO admission_receipts(admission_id,community_id,invite_id,account_id,member_id,expires_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          grant.id,
          invite.community_id,
          invite.id,
          user.id,
          member.rows[0].id,
          new Date(Date.now() + 600_000),
        ]
      );
      await client.query('UPDATE pending_admissions SET consumed_at=now() WHERE id=$1', [grant.id]);
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [invite.community_id, member.rows[0].id, 'member.admit', invite.id]
      );
      return member.rows[0].id;
    });
    deleteCookie(c, 'community_admission', { path: '/' });
    return json(c, CommunityWireInviteRedeemResponseSchema, { memberId });
  });
}
