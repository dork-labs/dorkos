import type { PoolClient } from 'pg';
import { accountErasureOpen, memberIsLeaving } from '../erasure/guards.js';
import { endExportJob } from '../exports/store.js';
import { mintHandle } from '../handles.js';
import { recordHostAudit } from '../host/authority.js';
import { ApiError } from '../http.js';
import { queueNotice } from '../mail/outbox.js';
import { OIDC_PROVIDER_ID } from '../oidc.js';
import { clearFormerMembership } from '../routes/community/members.js';
import { formatReplacementDate } from './dates.js';
import type { OwnerReplacementState } from './records.js';

/**
 * Serializes owner-replacement claims, as owner claims have their own key. It is taken before
 * any row lock, so two claims with one token queue here rather than on the community row.
 */
const OWNER_REPLACEMENT_CLAIM_LOCK = 77281506;

/** Lifecycles in which the named account may take ownership. */
const CLAIM_LIFECYCLES = ['active', 'archived', 'held'];

/** The one answer for a claim token that is unknown, sent again, or whose request ended. */
export const CLAIM_UNAVAILABLE = 'This ownership claim is unavailable.';

/** The answer when the signed-in account is not the one the request named. */
const WRONG_ACCOUNT = 'Sign in with the account named in the request, then try again.';

/** The signed-in account taking ownership. */
export interface OwnerReplacementClaimant {
  userId: string;
  /** Its account name, the display name of a membership made for it. */
  name: string;
}

/** What a claim changed: the community and the new owner's membership in it. */
export interface OwnerReplacementClaimed {
  community: { id: string; name: string };
  memberId: string;
}

interface LockedReplacement {
  id: string;
  state: OwnerReplacementState;
  claimant_named: boolean;
  claimant_oidc_issuer: string | null;
  claimant_oidc_subject: string | null;
  claimable_after: Date | null;
  claim_expires_at: Date | null;
}

interface LockedMember {
  id: string;
  community_id: string;
  user_id: string | null;
  role: 'owner' | 'admin' | 'member';
  active: boolean;
}

/**
 * Refuse unless the signed-in account is the one the request allows. A request that named no
 * account can be claimed by anyone holding the link, but only while the host has no single
 * sign-on: once it has, the host must ask again, naming someone. A request that named an
 * account needs the host's sign-in service to be the same one, exactly one account on this
 * host linked to that identity, and that account signed in.
 */
async function assertNamedAccount(
  client: PoolClient,
  replacement: LockedReplacement,
  userId: string,
  oidcIssuer: string | null
): Promise<void> {
  if (!replacement.claimant_named) {
    if (oidcIssuer !== null)
      throw new ApiError(
        409,
        'STATE_CONFLICT',
        'This host now uses a sign-in service, so the host must ask again.'
      );
    return;
  }
  if (oidcIssuer === null || oidcIssuer !== replacement.claimant_oidc_issuer)
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      "This host's sign-in service changed, so this claim can't be used. Ask the host for a new request."
    );
  const linked = await client.query<{ userId: string }>(
    `SELECT "userId" FROM account WHERE "providerId"=$1 AND "accountId"=$2 LIMIT 2`,
    [OIDC_PROVIDER_ID, replacement.claimant_oidc_subject]
  );
  if (linked.rows.length !== 1 || linked.rows[0].userId !== userId)
    throw new ApiError(403, 'FORBIDDEN', WRONG_ACCOUNT);
}

/**
 * Give the named account the community, in the caller's transaction, exactly as the owner's own
 * transfer would. Every check runs under the locks, taken in the replacement lock order:
 * community, then the replacement, then the claimant's account, then member rows in id order.
 * The account lock orders this against that account's erasure, which takes the account and
 * then its member rows; the owner's member lock orders it against the owner's erasure and
 * transfer.
 *
 * The claim must be `claimable` and inside its window, in an `active`, `archived`, or `held`
 * community, by the named account when there is one, and not by the owner, an account being
 * erased, or a member who is leaving. Then the owner becomes a `member` (keeping every
 * connection, agent, and session), the claimant's membership becomes `owner` (a former one is
 * reactivated, and an account with none gets a new one with its own handle), the lifecycle
 * version moves on, and the old owner's unfinished community exports are cancelled. The request
 * ends `completed` with its claim token spent and every object-only link dead, both audit trails
 * record it, and the old owner is told by email.
 *
 * @throws ApiError `403` {@link CLAIM_UNAVAILABLE} for a token that no longer works, and a `403`
 *   or `409` for every other refusal; nothing changes on any of them.
 */
export async function claimOwnerReplacement(
  client: PoolClient,
  input: {
    tokenHash: string;
    claimant: OwnerReplacementClaimant;
    /** The issuer the host's single sign-on uses now, or null when it has none. */
    oidcIssuer: string | null;
    now: Date;
  }
): Promise<OwnerReplacementClaimed> {
  const { claimant, now } = input;
  await client.query(`SELECT pg_advisory_xact_lock(${OWNER_REPLACEMENT_CLAIM_LOCK})`);
  // The tenant, found without locking the replacement: the community is always locked first.
  const candidate = await client.query<{ id: string; community_id: string }>(
    'SELECT id,community_id FROM owner_replacements WHERE claim_token_hash=$1',
    [input.tokenHash]
  );
  const found = candidate.rows[0];
  if (!found) throw new ApiError(403, 'FORBIDDEN', CLAIM_UNAVAILABLE);
  const community = await client.query<{ name: string; lifecycle: string }>(
    'SELECT name,lifecycle FROM communities WHERE id=$1 FOR UPDATE',
    [found.community_id]
  );
  const replacements = await client.query<LockedReplacement>(
    `SELECT id,state,claimant_named,claimant_oidc_issuer,claimant_oidc_subject,claimable_after,
       claim_expires_at
     FROM owner_replacements WHERE community_id=$1 AND id=$2 AND claim_token_hash=$3 FOR UPDATE`,
    [found.community_id, found.id, input.tokenHash]
  );
  const replacement = replacements.rows[0];
  const lifecycle = community.rows[0]?.lifecycle;
  if (!replacement || !lifecycle) throw new ApiError(403, 'FORBIDDEN', CLAIM_UNAVAILABLE);
  if (replacement.state === 'notifying')
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      "You can't take ownership yet. The waiting period starts once the owner has been told."
    );
  if (replacement.state === 'waiting' && replacement.claimable_after)
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      `You can take ownership after ${formatReplacementDate(replacement.claimable_after)}.`
    );
  // Belt and braces: the request was found by its live token, and of the open states that carry
  // one only `claimable` has a claim_expires_at (owner_replacements_claim_window), so the state
  // check guards against drift, not a gap the expiry check leaves today.
  if (
    replacement.state !== 'claimable' ||
    !replacement.claim_expires_at ||
    now >= replacement.claim_expires_at
  )
    throw new ApiError(403, 'FORBIDDEN', CLAIM_UNAVAILABLE);
  if (!CLAIM_LIFECYCLES.includes(lifecycle))
    throw new ApiError(409, 'STATE_CONFLICT', 'This community is not open to a new owner now.');
  await assertNamedAccount(client, replacement, claimant.userId, input.oidcIssuer);

  const account = await client.query('SELECT 1 FROM "user" WHERE id=$1 FOR SHARE', [
    claimant.userId,
  ]);
  if (!account.rowCount) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  if (await accountErasureOpen(client, claimant.userId))
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      "This account is being deleted, so it can't take ownership."
    );
  const members = await client.query<LockedMember>(
    `SELECT id,community_id,user_id,role,active FROM members
     WHERE community_id=$1 AND ((role='owner' AND active) OR user_id=$2)
     ORDER BY id FOR UPDATE`,
    [found.community_id, claimant.userId]
  );
  const owner = members.rows.find((member) => member.role === 'owner' && member.active);
  const own = members.rows.find((member) => member.user_id === claimant.userId);
  if (!owner?.user_id)
    throw new ApiError(409, 'STATE_CONFLICT', 'This community has no owner to replace.');
  if (owner.user_id === claimant.userId)
    throw new ApiError(409, 'STATE_CONFLICT', 'You already own this community.');
  if (own && (await memberIsLeaving(client, { ...own, user_id: claimant.userId })))
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      "You are leaving this community, so you can't take ownership."
    );

  // The swap, as a transfer does it: the one-owner index needs the old owner demoted first.
  await client.query("UPDATE members SET role='member' WHERE id=$1", [owner.id]);
  let memberId: string;
  if (own?.active) {
    await client.query("UPDATE members SET role='owner' WHERE id=$1", [own.id]);
    memberId = own.id;
  } else if (own) {
    await clearFormerMembership(client, own.id, found.community_id);
    await client.query("UPDATE members SET active=true,removed_at=NULL,role='owner' WHERE id=$1", [
      own.id,
    ]);
    memberId = own.id;
  } else {
    const handle = await mintHandle(client, found.community_id, claimant.name);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       VALUES($1,$2,$3,$4,'owner') RETURNING id`,
      [found.community_id, claimant.userId, claimant.name, handle]
    );
    memberId = inserted.rows[0].id;
    await client.query(
      'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
      [found.community_id, handle, memberId]
    );
  }
  await client.query('UPDATE communities SET lifecycle_version=lifecycle_version+1 WHERE id=$1', [
    found.community_id,
  ]);
  // A ready export is already refused to someone who is no longer the owner; one still being
  // made would be too, only later.
  const unfinished = await client.query<{ id: string }>(
    `SELECT id FROM export_archives
     WHERE community_id=$1 AND requester_member_id=$2 AND scope='owner'
       AND state IN ('queued','building') FOR UPDATE`,
    [found.community_id, owner.id]
  );
  for (const job of unfinished.rows)
    await endExportJob(client, job.id, { state: 'cancelled' }, now);

  await client.query(
    `UPDATE owner_replacements SET state='completed',new_owner_member_id=$3,ended_at=$4,
       claim_token_hash=NULL,claimant_oidc_issuer=NULL,claimant_oidc_subject=NULL
     WHERE community_id=$1 AND id=$2`,
    [found.community_id, replacement.id, memberId, now]
  );
  await recordHostAudit(
    client,
    { kind: 'system' },
    {
      action: 'owner_replacement.complete',
      communityId: found.community_id,
      nextState: 'completed',
      changedFields: ['owner_replacement'],
    }
  );
  await client.query(
    `INSERT INTO audit_events(
       community_id,actor_kind,action,subject_id,prior_state,next_state,changed_fields
     ) VALUES($1,'host','owner.replace',$2,$3,$4,ARRAY['owner_member_id'])`,
    [found.community_id, memberId, owner.id, memberId]
  );
  await queueNotice(
    client,
    {
      communityId: found.community_id,
      kind: 'owner_replacement.completed',
      subjectId: replacement.id,
      recipientUserId: owner.user_id,
    },
    now
  );
  return {
    community: { id: found.community_id, name: community.rows[0].name },
    memberId,
  };
}
