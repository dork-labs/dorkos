import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import type { z } from 'zod';
import {
  CommunityWireOwnerReplacementNoticeResponseSchema,
  CommunityWireOwnerReplacementObjectionRequestSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import {
  lifecycleError,
  requireMember,
  requirePrincipal,
  transaction,
  type Member,
} from '../../data.js';
import { ApiError, json, readJson } from '../../http.js';
import { endOwnerReplacement } from '../../owner-replacement/end.js';
import { ownerReplacementOptions } from '../../owner-replacement/options.js';
import {
  lockReplacement,
  OPEN_REPLACEMENT_STATES,
  type OwnerReplacementReason,
  type OwnerReplacementState,
} from '../../owner-replacement/records.js';
import { accountHasPassword } from '../account/account-password.js';

/** How long every member is told that the community has a new owner. */
const COMPLETION_NOTICE_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

/** Lifecycles in which the owner can keep ownership. An open request exists only in these. */
const OBJECTION_LIFECYCLES = ['active', 'archived', 'held'];

type NoticeResponse = z.infer<typeof CommunityWireOwnerReplacementNoticeResponseSchema>;

/**
 * The caller's membership for the notice read: a signed-in browser session, or a connection
 * grant from the member's own DorkOS installation. An agent's credential reads nothing here.
 */
async function noticeReader(
  c: Context,
  pool: Pool,
  auth: CommunityAuth
): Promise<Pick<Member, 'id' | 'user_id' | 'role' | 'community_id'>> {
  const principal = await requirePrincipal(c, auth, pool, 'read');
  if (principal.credentialKind === 'agent')
    throw new ApiError(403, 'FORBIDDEN', 'This connection cannot perform that action.');
  const member = await pool.query<Pick<Member, 'id' | 'user_id' | 'role' | 'community_id'>>(
    'SELECT id,user_id,role,community_id FROM members WHERE id=$1 AND community_id=$2 AND active',
    [principal.id, principal.community_id]
  );
  if (!member.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
  return member.rows[0];
}

/**
 * Register the members' side of an owner replacement in one community.
 *
 * `GET /owner-replacement` tells the owner about an open request (with the host's reference,
 * a reissued link, and what they can do about it), tells admins that one is open, and tells
 * every member for 7 days that the community has a new owner. It never names a host operator,
 * a key, a legal hold, or the account named in the request.
 *
 * `POST /owner-replacement/objection` is the owner keeping ownership from their own browser
 * session, with no password, so an owner who signs in only through single sign-on can say no.
 */
export function registerOwnerReplacementRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    auth: CommunityAuth;
    /** The clock completions are dated and objections are recorded by; tests inject it. */
    now: () => Date;
    /** How many days the host must wait to ask again after the owner keeps ownership. */
    objectionCooldownDays: number;
  }
): void {
  const { pool, auth, now, objectionCooldownDays } = deps;

  app.get('/owner-replacement', async (c) => {
    const member = await noticeReader(c, pool, auth);
    const at = now();
    const body: NoticeResponse = { open: null, completed: null };
    if (member.role === 'owner' || member.role === 'admin') {
      const open = await pool.query<{
        id: string;
        state: Extract<OwnerReplacementState, 'notifying' | 'waiting' | 'claimable'>;
        reason: OwnerReplacementReason;
        reference: string | null;
        requested_at: Date;
        claimable_after: Date | null;
        notice_state: 'pending' | 'accepted' | 'failed';
        claim_reissued_at: Date | null;
        lifecycle: string;
      }>(
        `SELECT r.id,r.state,r.reason,r.reference,r.requested_at,r.claimable_after,r.notice_state,
           r.claim_reissued_at,c.lifecycle
         FROM owner_replacements r JOIN communities c ON c.id=r.community_id
         WHERE r.community_id=$1 AND r.state=ANY($2::text[])`,
        [member.community_id, OPEN_REPLACEMENT_STATES]
      );
      const row = open.rows[0];
      if (row) {
        const shared = {
          replacementId: row.id,
          state: row.state,
          reason: row.reason,
          requestedAt: row.requested_at.toISOString(),
          claimableAfter: row.claimable_after?.toISOString() ?? null,
          noticeState: row.notice_state,
        };
        body.open =
          member.role === 'owner'
            ? {
                role: 'owner',
                ...shared,
                reference: row.reference,
                claimReissuedAt: row.claim_reissued_at?.toISOString() ?? null,
                options: ownerReplacementOptions({
                  lifecycle: row.lifecycle,
                  hasPassword: await accountHasPassword(pool, member.user_id),
                }),
                objectionCooldownDays,
              }
            : { role: 'admin', ...shared };
      }
    }
    const completed = await pool.query<{ display_name: string; ended_at: Date }>(
      `SELECT m.display_name,r.ended_at FROM owner_replacements r
       JOIN members m ON m.community_id=r.community_id AND m.id=r.new_owner_member_id
       WHERE r.community_id=$1 AND r.state='completed' AND r.ended_at>$2 AND r.ended_at<=$3
       ORDER BY r.ended_at DESC LIMIT 1`,
      [member.community_id, new Date(at.getTime() - COMPLETION_NOTICE_DAYS * DAY_MS), at]
    );
    if (completed.rows[0])
      body.completed = {
        newOwnerDisplayName: completed.rows[0].display_name,
        completedAt: completed.rows[0].ended_at.toISOString(),
      };
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireOwnerReplacementNoticeResponseSchema, body);
  });

  app.post('/owner-replacement/objection', async (c) => {
    // Only the owner's own browser: a connection, an agent, or any other bearer never reaches it.
    if (c.req.header('authorization'))
      throw new ApiError(403, 'FORBIDDEN', 'Keep ownership from your own signed-in browser.');
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireOwnerReplacementObjectionRequestSchema);
    await transaction(pool, async (client) => {
      // Community, then the replacement, then the owner's member row: the replacement lock order.
      const community = await client.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM communities WHERE id=$1 FOR UPDATE',
        [actor.community_id]
      );
      const lifecycle = community.rows[0]?.lifecycle ?? 'unavailable';
      if (!OBJECTION_LIFECYCLES.includes(lifecycle)) throw lifecycleError(lifecycle);
      const replacement = await lockReplacement(client, actor.community_id, body.replacementId);
      const current = await client.query<{ role: string }>(
        'SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
        [actor.id, actor.community_id]
      );
      if (current.rows[0]?.role !== 'owner')
        throw new ApiError(403, 'FORBIDDEN', 'Only the owner can keep ownership.');
      if (!replacement) throw new ApiError(404, 'NOT_FOUND', 'Owner replacement not found.');
      // Keeping ownership twice is still keeping it; nothing is written again.
      if (replacement.state === 'objected') return;
      if (!OPEN_REPLACEMENT_STATES.includes(replacement.state))
        throw new ApiError(409, 'STATE_CONFLICT', 'This request has already ended.');
      await endOwnerReplacement(client, {
        communityId: actor.community_id,
        replacementId: replacement.id,
        ending: { state: 'objected', ownerMemberId: actor.id },
        now: now(),
      });
    });
    return c.body(null, 204);
  });
}
