import type { Pool, PoolClient } from 'pg';
import { transaction } from '../data.js';
import { hashSecret, randomToken } from '../security.js';
import { endOwnerReplacement } from './end.js';
import { OPEN_REPLACEMENT_STATES, type OwnerReplacementState } from './records.js';

/**
 * Mint one object-only link for one send attempt of a notice, reminder, or claim-reissued
 * message, and return the page it opens. Only the token's hash is stored, dated from the
 * caller's clock. A token minted for an attempt that then fails is never deleted: a send that
 * timed out may still have been delivered, and a spare token can only object.
 */
export async function mintObjectToken(
  pool: Pick<Pool, 'query'>,
  input: {
    communityId: string;
    replacementId: string;
    outboxId: string;
    publicUrl: string;
    now: Date;
  }
): Promise<string> {
  const token = randomToken();
  await pool.query(
    `INSERT INTO owner_replacement_object_tokens(
       replacement_id,community_id,token_hash,outbox_id,created_at
     ) VALUES($1,$2,$3,$4,$5)`,
    [input.replacementId, input.communityId, hashSecret(token), input.outboxId, input.now]
  );
  return `${input.publicUrl}/keep-ownership#${token}`;
}

/** What using an object-only link did. */
export type ObjectTokenOutcome =
  /** The request was open, and it now ends as `objected`. */
  | { outcome: 'objected'; communityId: string; replacementId: string }
  /** The request already ended because the owner kept ownership: the same success again. */
  | { outcome: 'already_objected'; communityId: string; replacementId: string }
  /** The request ended some other way. */
  | { outcome: 'ended' }
  /** No such token. */
  | { outcome: 'unknown' };

/**
 * Use an object-only link: keep ownership, and nothing else. It is not a session and reaches
 * nothing else. A live token (its request open) marks itself used and closes the request as
 * `objected`, which kills every other token for it. A token whose request the owner already
 * kept (by this link, another one, or in the product) answers the same success and writes
 * nothing. Any other closed request is `ended`.
 *
 * Locks follow the replacement lock order: the community, then the replacement, then the token.
 */
export async function objectWithToken(
  pool: Pool,
  token: string,
  now: Date
): Promise<ObjectTokenOutcome> {
  const tokenHash = hashSecret(token);
  return transaction(pool, async (client: PoolClient) => {
    const found = await client.query<{ community_id: string; replacement_id: string }>(
      'SELECT community_id,replacement_id FROM owner_replacement_object_tokens WHERE token_hash=$1',
      [tokenHash]
    );
    const row = found.rows[0];
    if (!row) return { outcome: 'unknown' };
    await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [row.community_id]);
    const replacement = await client.query<{ state: OwnerReplacementState }>(
      'SELECT state FROM owner_replacements WHERE community_id=$1 AND id=$2 FOR UPDATE',
      [row.community_id, row.replacement_id]
    );
    const state = replacement.rows[0]?.state;
    if (!state) return { outcome: 'unknown' };
    const ids = { communityId: row.community_id, replacementId: row.replacement_id };
    if (state === 'objected') return { outcome: 'already_objected', ...ids };
    if (!OPEN_REPLACEMENT_STATES.includes(state)) return { outcome: 'ended' };
    await client.query(
      'UPDATE owner_replacement_object_tokens SET used_at=$2 WHERE token_hash=$1 AND used_at IS NULL',
      [tokenHash, now]
    );
    await endOwnerReplacement(client, {
      ...ids,
      ending: { state: 'objected', viaLink: true },
      now,
    });
    return { outcome: 'objected', ...ids };
  });
}
