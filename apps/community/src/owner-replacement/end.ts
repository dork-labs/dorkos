import type { PoolClient } from 'pg';
import { queueNotice } from '../mail/outbox.js';
import { currentOwnerAccount } from './records.js';

/** How an open replacement closes. A withdrawal says why. */
export type OwnerReplacementEnding =
  | { state: 'withdrawn'; cause: 'cancelled' | 'suspended' | 'deletion' }
  | { state: 'objected' | 'superseded' | 'expired' };

/**
 * Close one open replacement inside the caller's transaction, after the caller locked the
 * community. It re-reads the replacement under that lock, since a row read before the lock was
 * granted may be stale, and does nothing unless the replacement is still open.
 *
 * Closing writes the state and `ended_at` (and `withdrawn_cause` on a withdrawal), drops the
 * claim token, and clears the named account's issuer and subject, which identify a person and
 * must not outlive the request (`claimant_named` stays). Every object-only link dies with it,
 * because a link only works while its request is open. The owner is sent an
 * `owner_replacement.ended` notice unless `notifyOwner` is false, as when the owner acted.
 * Audit rows are the caller's: each transition writes its own.
 *
 * @returns Whether the replacement was open and is now closed.
 */
export async function endOwnerReplacement(
  client: PoolClient,
  input: {
    communityId: string;
    replacementId: string;
    ending: OwnerReplacementEnding;
    notifyOwner: boolean;
    now: Date;
  }
): Promise<boolean> {
  const ended = await client.query(
    `UPDATE owner_replacements SET state=$3,withdrawn_cause=$4,ended_at=$5,claim_token_hash=NULL,
       claimant_oidc_issuer=NULL,claimant_oidc_subject=NULL
     WHERE id=(
       SELECT id FROM owner_replacements
       WHERE community_id=$1 AND id=$2 AND state IN ('notifying','waiting','claimable')
       FOR UPDATE)`,
    [
      input.communityId,
      input.replacementId,
      input.ending.state,
      input.ending.state === 'withdrawn' ? input.ending.cause : null,
      input.now,
    ]
  );
  if (!ended.rowCount) return false;
  if (input.notifyOwner) {
    const owner = await currentOwnerAccount(client, input.communityId);
    if (owner)
      await queueNotice(
        client,
        {
          communityId: input.communityId,
          kind: 'owner_replacement.ended',
          subjectId: input.replacementId,
          recipientUserId: owner,
        },
        input.now
      );
  }
  return true;
}
