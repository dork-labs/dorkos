import type { PoolClient } from 'pg';
import { recordHostAudit, type HostActor } from '../host/authority.js';
import { queueNotice } from '../mail/outbox.js';
import { currentOwnerAccount } from './records.js';
import { statesBefore } from './state.js';

/**
 * How an open replacement closes, and who closed it. Each one decides the audit rows (the spec's
 * "Audit" table) and whether the owner is told: the owner is sent `owner_replacement.ended`
 * unless the owner is the one who acted.
 */
export type OwnerReplacementEnding =
  /** The host cancelled it: audited as that host person or key. */
  | { state: 'withdrawn'; cause: 'cancelled'; by: HostActor }
  /**
   * The host suspended the community, or it entered deletion (host-started or a takedown).
   * `quiet` sends the owner nothing, for a takedown the host chose not to tell them about.
   */
  | { state: 'withdrawn'; cause: 'suspended' | 'deletion'; quiet?: boolean }
  /** The owner handed the community on or asked to delete it. */
  | { state: 'superseded'; ownerMemberId: string }
  /** The owner kept ownership from a signed-in session. */
  | { state: 'objected'; ownerMemberId: string }
  /** The owner kept ownership from the email's object-only link, which proves only the mailbox. */
  | { state: 'objected'; viaLink: true }
  /** The claim window ended without a claim. */
  | { state: 'expired' };

/** The host audit action and tenant audit row for one ending. */
function auditsFor(ending: OwnerReplacementEnding): {
  hostAction: string;
  tenantAction: string;
  tenantActor: { kind: 'member'; memberId: string } | { kind: 'host' } | { kind: 'system' };
  changedFields: string[];
} {
  switch (ending.state) {
    case 'withdrawn':
      return {
        hostAction:
          ending.cause === 'cancelled' ? 'owner_replacement.cancel' : 'owner_replacement.withdrawn',
        tenantAction: 'owner.replacement.withdrawn',
        tenantActor: { kind: 'host' },
        changedFields: [],
      };
    case 'superseded':
      return {
        hostAction: 'owner_replacement.superseded',
        tenantAction: 'owner.replacement.superseded',
        tenantActor: { kind: 'member', memberId: ending.ownerMemberId },
        changedFields: [],
      };
    case 'objected':
      return 'viaLink' in ending
        ? {
            hostAction: 'owner_replacement.objected',
            tenantAction: 'owner.replacement.objected',
            tenantActor: { kind: 'system' },
            changedFields: ['via_link'],
          }
        : {
            hostAction: 'owner_replacement.objected',
            tenantAction: 'owner.replacement.objected',
            tenantActor: { kind: 'member', memberId: ending.ownerMemberId },
            changedFields: [],
          };
    case 'expired':
      return {
        hostAction: 'owner_replacement.expired',
        tenantAction: 'owner.replacement.expired',
        tenantActor: { kind: 'system' },
        changedFields: [],
      };
  }
}

/**
 * Close an open replacement inside the caller's transaction, after the caller locked the
 * community. It re-reads the replacement under that lock, since a row read before the lock was
 * granted may be stale, and does nothing unless the replacement is still open. Without a
 * `replacementId` it closes the community's open replacement, if there is one.
 *
 * Closing writes the state and `ended_at` (and `withdrawn_cause` on a withdrawal), drops the
 * claim token, and clears the named account's issuer and subject, which identify a person and
 * must not outlive the request (`claimant_named` stays). Every object-only link dies with it,
 * because a link only works while its request is open. It writes the host and tenant audit rows
 * the spec lists for the ending; neither names a member on the host plane. The owner is sent
 * `owner_replacement.ended` for a withdrawal or an expiry (unless a takedown's withdrawal is
 * `quiet`), and nothing when they acted.
 *
 * @returns The closed replacement's id, or null when nothing was open.
 */
export async function endOwnerReplacement(
  client: PoolClient,
  input: {
    communityId: string;
    replacementId?: string;
    ending: OwnerReplacementEnding;
    now: Date;
  }
): Promise<string | null> {
  const { ending } = input;
  const ended = await client.query<{ id: string }>(
    `UPDATE owner_replacements SET state=$3,withdrawn_cause=$4,ended_at=$5,claim_token_hash=NULL,
       claimant_oidc_issuer=NULL,claimant_oidc_subject=NULL
     WHERE id=(
       SELECT id FROM owner_replacements
       WHERE community_id=$1 AND ($2::uuid IS NULL OR id=$2) AND state=ANY($6::text[])
       FOR UPDATE)
     RETURNING id`,
    [
      input.communityId,
      input.replacementId ?? null,
      ending.state,
      ending.state === 'withdrawn' ? ending.cause : null,
      input.now,
      statesBefore(ending.state),
    ]
  );
  const replacementId = ended.rows[0]?.id;
  if (!replacementId) return null;

  const audits = auditsFor(ending);
  await recordHostAudit(
    client,
    ending.state === 'withdrawn' && ending.cause === 'cancelled' ? ending.by : { kind: 'system' },
    {
      action: audits.hostAction,
      communityId: input.communityId,
      nextState: ending.state,
      changedFields: ['owner_replacement'],
    }
  );
  await client.query(
    `INSERT INTO audit_events(
       community_id,actor_kind,actor_member_id,action,subject_id,next_state,changed_fields
     ) VALUES($1,$2,$3,$4,$5,$6,$7::text[])`,
    [
      input.communityId,
      audits.tenantActor.kind,
      audits.tenantActor.kind === 'member' ? audits.tenantActor.memberId : null,
      audits.tenantAction,
      replacementId,
      ending.state,
      audits.changedFields,
    ]
  );

  const tellOwner =
    ending.state === 'expired' ||
    (ending.state === 'withdrawn' && !('quiet' in ending && ending.quiet));
  if (tellOwner) {
    const owner = await currentOwnerAccount(client, input.communityId);
    if (owner)
      await queueNotice(
        client,
        {
          communityId: input.communityId,
          kind: 'owner_replacement.ended',
          subjectId: replacementId,
          recipientUserId: owner,
        },
        input.now
      );
  }
  return replacementId;
}
