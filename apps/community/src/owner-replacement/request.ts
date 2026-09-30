import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  assertHostActor,
  hostActorRequester,
  recordHostAudit,
  type HostActor,
} from '../host/authority.js';
import { ApiError } from '../http.js';
import { queueNotice } from '../mail/outbox.js';
import { formatReplacementDate } from './dates.js';
import {
  cooldownEnds,
  hostReplacementSql,
  readHostReplacement,
  type OwnerReplacementReason,
  type OwnerReplacementRow,
} from './records.js';

/** A request within this long of a withdrawal of the same community gets the long wait. */
const RECENT_WITHDRAWAL_DAYS = 30;

/** What the host asked for, with the checks that need no database already passed. */
export interface OwnerReplacementRequest {
  communityId: string;
  actor: HostActor;
  idempotencyKey: string;
  lifecycleVersion: number;
  reason: OwnerReplacementReason;
  reference: string | null;
  /** The named account: the host's configured issuer and the subject it gives this host. */
  claimant: { issuer: string; subject: string } | null;
  /** The hash of the new claim token; the token itself never reaches the database. */
  claimTokenHash: string;
  /**
   * Why the owner's notice cannot be sent, or null when it can (mail is set up and the mail
   * worker can compose an `owner_replacement.notice`). A replacement cannot start without it.
   */
  noticeRefusal: string | null;
  objectionCooldownDays: number;
  now: Date;
}

/**
 * The idempotency hash of a request: everything the host chose, never the password. Keyed with
 * the community, the requesting actor, and the key, so the same key elsewhere is its own request.
 */
export function replacementPayloadHash(input: {
  lifecycleVersion: number;
  reason: OwnerReplacementReason;
  reference: string | null;
  oidcSubject: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        lifecycleVersion: input.lifecycleVersion,
        reason: input.reason,
        reference: input.reference,
        oidcSubject: input.oidcSubject,
      })
    )
    .digest('hex');
}

/**
 * Start replacing a community's owner, in the caller's transaction. It locks the community
 * first and checks every rule under that lock: the actor is still live, the owner's notice can be sent, the
 * idempotency key, the lifecycle and its version, one open request at a time, and the
 * cooling-off after an objection. It then locks the owner's member row, inserts
 * the replacement in `notifying` with the claim token's hash, queues one notice to the owner,
 * and audits both planes. Neither audit row names a member, the reference, or the subject.
 *
 * A replay of the same actor's key with the same request returns the first replacement
 * (`replayed: true`); the same key with a different request is `409 IDEMPOTENCY_CONFLICT`.
 */
export async function requestOwnerReplacement(
  client: PoolClient,
  input: OwnerReplacementRequest
): Promise<{ row: OwnerReplacementRow; replayed: boolean }> {
  const locked = await client.query<{ lifecycle: string; lifecycle_version: number }>(
    'SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1 FOR UPDATE',
    [input.communityId]
  );
  await assertHostActor(client, input.actor, input.now);
  const community = locked.rows[0];
  if (!community) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
  if (input.noticeRefusal)
    throw new ApiError(409, 'NOTICE_DELIVERY_UNAVAILABLE', input.noticeRefusal);

  // The community lock serializes every request for it, so one key is looked up and written
  // by one request at a time.
  const requester = hostActorRequester(input.actor);
  const hash = replacementPayloadHash({
    lifecycleVersion: input.lifecycleVersion,
    reason: input.reason,
    reference: input.reference,
    oidcSubject: input.claimant?.subject ?? null,
  });
  const existing = await client.query<OwnerReplacementRow>(
    `${hostReplacementSql}
     WHERE r.community_id=$1 AND r.requested_by_host_actor=$2 AND r.idempotency_key=$3`,
    [input.communityId, requester, input.idempotencyKey]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].payload_hash !== hash)
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'That idempotency key was used for a different request.'
      );
    return { row: existing.rows[0], replayed: true };
  }

  if (community.lifecycle === 'pending_owner')
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'This community has no owner yet. Reissue its owner claim instead.'
    );
  if (!['active', 'archived', 'held'].includes(community.lifecycle))
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'Only an active, archived, or held community can have its owner replaced.'
    );
  if (community.lifecycle_version !== input.lifecycleVersion)
    throw new ApiError(409, 'STATE_CONFLICT', 'Community lifecycle changed.');

  const open = await client.query(
    `SELECT 1 FROM owner_replacements
     WHERE community_id=$1 AND state IN ('notifying','waiting','claimable')`,
    [input.communityId]
  );
  if (open.rowCount)
    throw new ApiError(
      409,
      'OWNER_REPLACEMENT_OPEN',
      'A request to replace this owner is already open.'
    );

  const history = await client.query<{
    last_objection: Date | null;
    recent_withdrawal: boolean;
  }>(
    `SELECT
       (SELECT max(ended_at) FROM owner_replacements
        WHERE community_id=$1 AND state='objected') AS last_objection,
       EXISTS(SELECT 1 FROM owner_replacements
        WHERE community_id=$1 AND state='withdrawn'
          AND ended_at>$2::timestamptz - $3 * interval '1 day') AS recent_withdrawal`,
    [input.communityId, input.now, RECENT_WITHDRAWAL_DAYS]
  );
  const { last_objection: lastObjection, recent_withdrawal: afterWithdrawal } = history.rows[0];
  if (lastObjection) {
    const until = cooldownEnds(lastObjection, input.objectionCooldownDays);
    if (input.now < until)
      throw new ApiError(
        409,
        'OWNER_REPLACEMENT_COOLDOWN',
        `The owner kept ownership on ${formatReplacementDate(lastObjection)}. You can ask again after ${formatReplacementDate(until)}.`
      );
  }

  // The owner's member row, after the community. The account row is deliberately not locked:
  // an account erasure locks the account and then its member rows, so taking them the other way
  // round here would deadlock with it. The member lock is enough, because the erasure re-reads
  // this row under its own lock and refuses an owner.
  const owner = await client.query<{ id: string; user_id: string | null }>(
    `SELECT id,user_id FROM members WHERE community_id=$1 AND role='owner' AND active
     ORDER BY id FOR UPDATE`,
    [input.communityId]
  );
  const prior = owner.rows[0];
  if (!prior?.user_id)
    throw new ApiError(409, 'STATE_CONFLICT', 'This community has no owner to notify.');

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO owner_replacements(
       community_id,state,reason,reference,claimant_named,claimant_oidc_issuer,
       claimant_oidc_subject,claim_token_hash,requested_by_host_actor,idempotency_key,
       payload_hash,after_objection,after_withdrawal,prior_owner_member_id,requested_at
     ) VALUES($1,'notifying',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      input.communityId,
      input.reason,
      input.reference,
      input.claimant !== null,
      input.claimant?.issuer ?? null,
      input.claimant?.subject ?? null,
      input.claimTokenHash,
      requester,
      input.idempotencyKey,
      hash,
      lastObjection !== null,
      afterWithdrawal,
      prior.id,
      input.now,
    ]
  );
  const replacementId = inserted.rows[0].id;
  await queueNotice(
    client,
    {
      communityId: input.communityId,
      kind: 'owner_replacement.notice',
      subjectId: replacementId,
      recipientUserId: prior.user_id,
    },
    input.now
  );
  await recordHostAudit(client, input.actor, {
    action: 'owner_replacement.request',
    communityId: input.communityId,
    nextState: 'notifying',
    changedFields: ['owner_replacement'],
  });
  await client.query(
    `INSERT INTO audit_events(community_id,actor_kind,action,subject_id,next_state)
     VALUES($1,'host','owner.replacement.requested',$2,'notifying')`,
    [input.communityId, replacementId]
  );
  const row = await readHostReplacement(client, input.communityId, replacementId);
  if (!row) throw new Error('The new owner replacement could not be read back');
  return { row, replayed: false };
}
