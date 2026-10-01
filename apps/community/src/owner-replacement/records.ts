import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type {
  CommunityAdminOwnerReplacementReasonSchema,
  CommunityAdminOwnerReplacementSchema,
  CommunityAdminOwnerReplacementStateSchema,
} from '@dorkos/shared/community-admin-wire';

const DAY_MS = 24 * 60 * 60_000;

/** One owner replacement's state. */
export type OwnerReplacementState = z.infer<typeof CommunityAdminOwnerReplacementStateSchema>;
/** Why a host asked to replace an owner. */
export type OwnerReplacementReason = z.infer<typeof CommunityAdminOwnerReplacementReasonSchema>;

/** The states a replacement is open in. At most one per community is ever open. */
export const OPEN_REPLACEMENT_STATES: readonly OwnerReplacementState[] = [
  'notifying',
  'waiting',
  'claimable',
];

/**
 * One owner replacement as the host plane reads it. It holds no member id and no OIDC subject:
 * those columns stay in the table for the tenant plane and the claim.
 */
export interface OwnerReplacementRow {
  id: string;
  community_id: string;
  state: OwnerReplacementState;
  reason: OwnerReplacementReason;
  reference: string | null;
  claimant_named: boolean;
  requested_at: Date;
  requested_by_host_actor: string;
  /** A host person's display name or a key's prefix, read by the projection's joins. */
  requested_by_label: string | null;
  payload_hash: string;
  notice_state: 'pending' | 'accepted' | 'failed';
  notice_resolved_at: Date | null;
  verified_address: boolean | null;
  after_objection: boolean;
  after_withdrawal: boolean;
  claimable_after: Date | null;
  claim_expires_at: Date | null;
  claim_reissued_at: Date | null;
  ended_at: Date | null;
  withdrawn_cause: 'cancelled' | 'suspended' | 'deletion' | null;
}

/**
 * Select every host-visible replacement column; append a `WHERE` (on `r`) and an `ORDER BY`.
 * The requester's label comes from the host operator's account or the key, looked up by id.
 */
export const hostReplacementSql = `SELECT r.id,r.community_id,r.state,r.reason,r.reference,
  r.claimant_named,r.requested_at,r.requested_by_host_actor,r.payload_hash,r.notice_state,
  r.notice_resolved_at,r.verified_address,r.after_objection,r.after_withdrawal,r.claimable_after,
  r.claim_expires_at,r.claim_reissued_at,r.ended_at,r.withdrawn_cause,
  COALESCE(u.name,k.prefix) AS requested_by_label
  FROM owner_replacements r
  LEFT JOIN "user" u ON r.requested_by_host_actor LIKE 'person:%'
    AND u.id=substring(r.requested_by_host_actor FROM 8)
  LEFT JOIN host_api_keys k ON r.requested_by_host_actor LIKE 'api_key:%'
    AND k.id=CASE WHEN r.requested_by_host_actor LIKE 'api_key:%'
      THEN substring(r.requested_by_host_actor FROM 9)::uuid END`;

/**
 * Which waiting period a replacement has, or null until its notice resolves. The short wait
 * applies only when the mail server accepted the notice, the owner's address was marked
 * verified, the owner never objected before, no request was withdrawn in the 30 days before,
 * and the reason is not that the owner left the group. Anything else gets the long wait.
 */
export function replacementWait(row: {
  notice_state: OwnerReplacementRow['notice_state'];
  verified_address: boolean | null;
  after_objection: boolean;
  after_withdrawal: boolean;
  reason: OwnerReplacementReason;
}): 'standard' | 'long' | null {
  if (row.notice_state === 'pending') return null;
  const standard =
    row.notice_state === 'accepted' &&
    row.verified_address === true &&
    !row.after_objection &&
    !row.after_withdrawal &&
    row.reason !== 'owner_left_group';
  return standard ? 'standard' : 'long';
}

/** When the host may ask again after an objection that ended at `endedAt`. */
export function cooldownEnds(endedAt: Date, cooldownDays: number): Date {
  return new Date(endedAt.getTime() + cooldownDays * DAY_MS);
}

/** The claim page for a token, with the token in the fragment so it never reaches a server log. */
export function claimUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/owner-replacement#${token}`;
}

/** The host view of one replacement: ids, states, dates, the reason, and the host's reference. */
export function projectOwnerReplacement(
  row: OwnerReplacementRow,
  cooldownDays: number
): z.infer<typeof CommunityAdminOwnerReplacementSchema> {
  const [kind] = row.requested_by_host_actor.split(':', 1) as ['person' | 'api_key'];
  return {
    replacementId: row.id,
    communityId: row.community_id,
    state: row.state,
    reason: row.reason,
    reference: row.reference,
    claimantNamed: row.claimant_named,
    requestedAt: row.requested_at.toISOString(),
    requestedBy: {
      kind,
      // An operator whose account was erased leaves no name behind.
      label: row.requested_by_label ?? (kind === 'person' ? 'Former host operator' : 'Host key'),
    },
    notice: {
      state: row.notice_state,
      resolvedAt: row.notice_resolved_at?.toISOString() ?? null,
      verifiedAddress: row.verified_address,
    },
    wait: replacementWait(row),
    afterObjection: row.after_objection,
    afterWithdrawal: row.after_withdrawal,
    claimableAfter: row.claimable_after?.toISOString() ?? null,
    claimExpiresAt: row.claim_expires_at?.toISOString() ?? null,
    claimReissuedAt: row.claim_reissued_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    withdrawnBecause: row.withdrawn_cause,
    cooldownUntil:
      row.state === 'objected' && row.ended_at
        ? cooldownEnds(row.ended_at, cooldownDays).toISOString()
        : null,
  };
}

/** Read one replacement of one community for the host, or null. */
export async function readHostReplacement(
  client: Pick<PoolClient, 'query'>,
  communityId: string,
  replacementId: string
): Promise<OwnerReplacementRow | null> {
  const row = await client.query<OwnerReplacementRow>(
    `${hostReplacementSql} WHERE r.community_id=$1 AND r.id=$2`,
    [communityId, replacementId]
  );
  return row.rows[0] ?? null;
}

/**
 * Lock one replacement of one community, after the caller locked the community. A replacement
 * read before the community lock was granted may be stale, so every change re-reads it here.
 *
 * @returns The replacement's id and state, or null when the community has no such replacement.
 */
export async function lockReplacement(
  client: PoolClient,
  communityId: string,
  replacementId: string
): Promise<{ id: string; state: OwnerReplacementState } | null> {
  const row = await client.query<{ id: string; state: OwnerReplacementState }>(
    'SELECT id,state FROM owner_replacements WHERE community_id=$1 AND id=$2 FOR UPDATE',
    [communityId, replacementId]
  );
  return row.rows[0] ?? null;
}

/**
 * The account of the community's current owner, or null. The notices about a replacement go to
 * whoever owns the community when they are queued.
 */
export async function currentOwnerAccount(
  client: PoolClient,
  communityId: string
): Promise<string | null> {
  const owner = await client.query<{ user_id: string | null }>(
    "SELECT user_id FROM members WHERE community_id=$1 AND role='owner' AND active",
    [communityId]
  );
  return owner.rows[0]?.user_id ?? null;
}
