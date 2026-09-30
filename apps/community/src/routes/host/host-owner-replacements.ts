import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityAdminOwnerReplacementCancelRequestSchema,
  CommunityAdminOwnerReplacementClaimTokenRequestSchema,
  CommunityAdminOwnerReplacementClaimTokenSchema,
  CommunityAdminOwnerReplacementCreateResponseSchema,
  CommunityAdminOwnerReplacementListSchema,
  CommunityAdminOwnerReplacementRequestSchema,
  CommunityAdminOwnerReplacementSchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityConfig } from '../../config.js';
import { transaction } from '../../data.js';
import { parseHostCommunityId } from '../../host/communities.js';
import {
  assertHostActor,
  recordHostAudit,
  type HostActor,
  type HostAuthority,
} from '../../host/authority.js';
import { ApiError, json, readJson } from '../../http.js';
import { queueNotice, type NoticeKind } from '../../mail/outbox.js';
import { endOwnerReplacement } from '../../owner-replacement/end.js';
import {
  claimUrl,
  currentOwnerAccount,
  hostReplacementSql,
  lockReplacement,
  OPEN_REPLACEMENT_STATES,
  projectOwnerReplacement,
  readHostReplacement,
  type OwnerReplacementRow,
} from '../../owner-replacement/records.js';
import { requestOwnerReplacement } from '../../owner-replacement/request.js';
import type { ConfirmPassword } from '../../password-confirmation.js';
import { hashSecret, randomToken } from '../../security.js';

const LIST_LIMIT = 50;

/**
 * Why a notice of `kind` cannot be sent, or null when it can. Without mail the host is told to
 * set it up; with mail but no way yet to write this notice, the feature is simply not available.
 */
function noticeRefusal(
  canSendNotice: (kind: NoticeKind) => boolean,
  config: CommunityConfig,
  kind: NoticeKind
): string | null {
  if (canSendNotice(kind)) return null;
  return config.mail === null
    ? "This host can't send email, so it can't give the owner notice. Set up mail first."
    : "This server can't send the owner's notice yet, so it can't replace an owner.";
}
const ReplacementPathSchema = z.strictObject({ communityId: z.uuid(), replacementId: z.uuid() });

/** Parse a replacement route's ids; a malformed one is the same 404 as an unknown one. */
function replacementPath(communityId: string | undefined, replacementId: string | undefined) {
  const parsed = ReplacementPathSchema.safeParse({ communityId, replacementId });
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Owner replacement not found.');
  return parsed.data;
}

/**
 * Lock a community and one of its open replacements for a host change, and recheck the actor.
 * An unknown community or replacement is `404`; a closed replacement is `409`.
 */
async function lockOpenReplacement(
  client: PoolClient,
  actor: HostActor,
  ids: { communityId: string; replacementId: string },
  now: Date
): Promise<void> {
  const community = await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [
    ids.communityId,
  ]);
  await assertHostActor(client, actor, now);
  if (!community.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Owner replacement not found.');
  const replacement = await lockReplacement(client, ids.communityId, ids.replacementId);
  if (!replacement) throw new ApiError(404, 'NOT_FOUND', 'Owner replacement not found.');
  if (!OPEN_REPLACEMENT_STATES.includes(replacement.state))
    throw new ApiError(409, 'STATE_CONFLICT', 'This request has already ended.');
}

/**
 * Register the host's owner-replacement routes. Every one needs `communities:ownership`, which
 * no other scope implies. A person starting a replacement proves it with their password; a key
 * never sends one. Nothing here returns a member id, name, email, or the named account's
 * subject: a replacement is ids, states, dates, the reason, and the host's own reference.
 */
export function registerHostOwnerReplacementRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    config: CommunityConfig;
    authority: HostAuthority;
    now: () => Date;
    confirmPassword: ConfirmPassword;
    /** Whether mail is set up and the mail worker can compose a notice of this kind. */
    canSendNotice: (kind: NoticeKind) => boolean;
    /** Whether an account has a password; one that signs in only through single sign-on does not. */
    hasPassword: (userId: string) => Promise<boolean>;
  }
): void {
  const { pool, config, authority, now, confirmPassword, canSendNotice, hasPassword } = deps;
  const cooldownDays = config.ownerReplacement.objectionCooldownDays;
  const project = (row: OwnerReplacementRow) => projectOwnerReplacement(row, cooldownDays);

  app.post('/host/communities/:id/owner-replacements', async (c) => {
    const actor = await authority.require(c, 'communities:ownership');
    const body = await readJson(c, CommunityAdminOwnerReplacementRequestSchema);
    const communityId = parseHostCommunityId(c.req.param('id'));
    if (actor.kind === 'api_key' && body.password !== undefined)
      throw new ApiError(400, 'STATE_CONFLICT', 'A host API key does not send a password.');
    if (actor.kind === 'person') {
      // An operator who signs in only through single sign-on has no password to confirm. They
      // hear so first, whatever they sent, and use a key with this scope instead.
      if (!(await hasPassword(actor.userId)))
        throw new ApiError(403, 'PASSWORD_REQUIRED', 'Set a password in your account to do this.');
      if (!body.password)
        throw new ApiError(403, 'REAUTH_REQUIRED', 'Enter your password to take this action.');
      await confirmPassword(c, actor.userId, body.password);
    }
    const subject = body.claimant.oidcSubject;
    if (config.oidc && subject === null)
      throw new ApiError(
        400,
        'STATE_CONFLICT',
        'Name the new owner by the sign-in ID your sign-in service gives them.'
      );
    if (!config.oidc && subject !== null)
      throw new ApiError(
        409,
        'STATE_CONFLICT',
        'This host has no single sign-on to name an account with.'
      );
    const token = randomToken();
    const result = await transaction(pool, (client) =>
      requestOwnerReplacement(client, {
        communityId,
        actor,
        idempotencyKey: body.idempotencyKey,
        lifecycleVersion: body.lifecycleVersion,
        reason: body.reason,
        reference: body.reference,
        claimant: config.oidc && subject !== null ? { issuer: config.oidc.issuer, subject } : null,
        claimTokenHash: hashSecret(token),
        noticeRefusal: noticeRefusal(canSendNotice, config, 'owner_replacement.notice'),
        objectionCooldownDays: cooldownDays,
        now: now(),
      })
    );
    c.header('Cache-Control', 'no-store');
    return json(
      c,
      CommunityAdminOwnerReplacementCreateResponseSchema,
      {
        replacement: project(result.row),
        claimToken: result.replayed ? null : token,
        claimUrl: result.replayed ? null : claimUrl(config.publicUrl, token),
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201
    );
  });

  app.get('/host/communities/:id/owner-replacements', async (c) => {
    await authority.require(c, 'communities:ownership');
    const communityId = parseHostCommunityId(c.req.param('id'));
    const community = await pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId]);
    if (!community.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
    const rows = await pool.query<OwnerReplacementRow>(
      `${hostReplacementSql} WHERE r.community_id=$1
       ORDER BY r.requested_at DESC,r.id DESC LIMIT ${LIST_LIMIT}`,
      [communityId]
    );
    return json(c, CommunityAdminOwnerReplacementListSchema, {
      replacements: rows.rows.map(project),
    });
  });

  app.post('/host/communities/:id/owner-replacements/:replacementId/cancel', async (c) => {
    const actor = await authority.require(c, 'communities:ownership');
    await readJson(c, CommunityAdminOwnerReplacementCancelRequestSchema);
    const ids = replacementPath(c.req.param('id'), c.req.param('replacementId'));
    const row = await transaction(pool, async (client) => {
      const at = now();
      await lockOpenReplacement(client, actor, ids, at);
      await endOwnerReplacement(client, {
        ...ids,
        ending: { state: 'withdrawn', cause: 'cancelled', by: actor },
        now: at,
      });
      return readHostReplacement(client, ids.communityId, ids.replacementId);
    });
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Owner replacement not found.');
    return json(c, CommunityAdminOwnerReplacementSchema, project(row));
  });

  app.post('/host/communities/:id/owner-replacements/:replacementId/claim-token', async (c) => {
    const actor = await authority.require(c, 'communities:ownership');
    await readJson(c, CommunityAdminOwnerReplacementClaimTokenRequestSchema);
    const ids = replacementPath(c.req.param('id'), c.req.param('replacementId'));
    const token = randomToken();
    await transaction(pool, async (client) => {
      const at = now();
      await lockOpenReplacement(client, actor, ids, at);
      // A new link is announced to the owner, so it cannot be issued while that notice cannot.
      const refusal = noticeRefusal(canSendNotice, config, 'owner_replacement.claim_reissued');
      if (refusal) throw new ApiError(409, 'NOTICE_DELIVERY_UNAVAILABLE', refusal);
      const owner = await currentOwnerAccount(client, ids.communityId);
      if (!owner)
        throw new ApiError(409, 'STATE_CONFLICT', 'This community has no owner to notify.');
      // The old token stops working here; no date moves.
      await client.query(
        `UPDATE owner_replacements SET claim_token_hash=$3,claim_reissued_at=$4
         WHERE community_id=$1 AND id=$2`,
        [ids.communityId, ids.replacementId, hashSecret(token), at]
      );
      await queueNotice(
        client,
        {
          communityId: ids.communityId,
          kind: 'owner_replacement.claim_reissued',
          subjectId: ids.replacementId,
          recipientUserId: owner,
        },
        at
      );
      await recordHostAudit(client, actor, {
        action: 'owner_replacement.claim_token.reissue',
        communityId: ids.communityId,
        changedFields: ['owner_replacement_claim'],
      });
      await client.query(
        `INSERT INTO audit_events(community_id,actor_kind,action,subject_id)
         VALUES($1,'host','owner.replacement.claim_reissued',$2)`,
        [ids.communityId, ids.replacementId]
      );
    });
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityAdminOwnerReplacementClaimTokenSchema, {
      replacementId: ids.replacementId,
      claimToken: token,
      claimUrl: claimUrl(config.publicUrl, token),
    });
  });
}
