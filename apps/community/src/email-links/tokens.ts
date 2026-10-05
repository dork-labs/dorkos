import type { Pool, PoolClient } from 'pg';
import type { CommunityConfig } from '../config.js';
import { signInRefusal } from '../erasure/guards.js';
import { hashSecret, hmacSecret } from '../security.js';
import { signInHoldOnly } from '../sign-in/link-gate.js';
import type { EmailLinkKind } from './model.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** A link's row, as stored. */
interface TokenRow {
  token_hash: string;
  kind: EmailLinkKind;
  user_id: string;
  email_hash: string;
  password_fingerprint: string | null;
  pending_link_hash: string | null;
  expires_at: Date;
  live: boolean;
}

/** The account a link belongs to, as read with the link. */
export interface LinkAccount {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** The fingerprint of an account's password: a hash of its stored hash, or `none`. */
export async function passwordFingerprint(client: Queryable, userId: string): Promise<string> {
  const row = await client.query<{ password: string | null }>(
    `SELECT password FROM account WHERE "userId"=$1 AND "providerId"='credential'`,
    [userId]
  );
  const hash = row.rows[0]?.password;
  return hash ? hashSecret(hash) : 'none';
}

/**
 * Whether `pendingHash` names a live sign-in hold for this account: the hold the request named,
 * still unused and unexpired.
 */
export async function liveHoldFor(
  client: Queryable,
  pendingHash: string | null,
  userId: string,
  { lock = false } = {}
): Promise<{ provider_id: string; account_id: string } | null> {
  if (!pendingHash) return null;
  const row = await client.query<{ provider_id: string; account_id: string }>(
    `SELECT provider_id,account_id FROM pending_sign_in_links
     WHERE token_hash=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now()
       AND ${signInHoldOnly}
     ${lock ? 'FOR UPDATE' : ''}`,
    [pendingHash, userId]
  );
  return row.rows[0] ?? null;
}

const TOKEN_COLUMNS = `token_hash,kind,user_id,email_hash,password_fingerprint,pending_link_hash,
  expires_at,(consumed_at IS NULL AND superseded_at IS NULL AND expires_at>now()) AS live`;

/** What {@link checkLink} found. */
export type LinkCheck =
  /** Unknown, used, replaced or expired: answer `410` and change nothing. */
  | { state: 'expired' }
  /** A sign-in link opened in a browser that does not hold its sign-in: `410`, token untouched. */
  | { state: 'elsewhere' }
  /** The address or the password changed since it was sent: `410`, and the token is dead. */
  | { state: 'stale' }
  /** The account may not sign in now: `403`, token kept. */
  | { state: 'refused'; message: string }
  | {
      state: 'ok';
      account: LinkAccount;
      expiresAt: Date;
      /** The held sign-in a sign-in link completes. */
      hold: { pendingHash: string; providerId: string; accountId: string } | null;
    };

/**
 * Run every check a link must pass before it is used or shown (spec §5), in order:
 *
 * 1. it exists, is this kind, unused, not replaced, and unexpired (on the database's clock);
 * 2. a sign-in link only: this browser holds the sign-in hold its request named, still live;
 * 3. the account's address is still the one it was sent to;
 * 4. a reset link only: the password is still the one it was sent against (none, set, reset or
 *    recovered since all count as a change);
 * 5. the account may sign in now.
 *
 * With `lock`, the caller's transaction must already hold the account's `"user"` row and its
 * `members` rows; the token row is locked here, and a stale token is marked replaced in that
 * transaction (the caller commits, then answers `410`). Without `lock` nothing is written: the
 * page's look before use.
 */
export async function checkLink(
  client: Queryable,
  input: {
    tokenHash: string;
    kind: EmailLinkKind;
    config: Pick<CommunityConfig, 'authSecret'>;
    /** The hash of the sign-in hold this browser holds, for a sign-in link. */
    pendingHash: string | null;
    lock: boolean;
  }
): Promise<LinkCheck> {
  const found = await client.query<TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM email_link_tokens WHERE token_hash=$1
     ${input.lock ? 'FOR UPDATE' : ''}`,
    [input.tokenHash]
  );
  const token = found.rows[0];
  if (!token || token.kind !== input.kind || !token.live) return { state: 'expired' };
  let hold: { pendingHash: string; providerId: string; accountId: string } | null = null;
  if (token.kind === 'sign_in') {
    const held =
      input.pendingHash === token.pending_link_hash
        ? await liveHoldFor(client, input.pendingHash, token.user_id, { lock: input.lock })
        : null;
    if (!held || !token.pending_link_hash) return { state: 'elsewhere' };
    hold = {
      pendingHash: token.pending_link_hash,
      providerId: held.provider_id,
      accountId: held.account_id,
    };
  }
  const user = await client.query<LinkAccount>(
    'SELECT id,email,"emailVerified" FROM "user" WHERE id=$1',
    [token.user_id]
  );
  const account = user.rows[0];
  if (!account) return { state: 'expired' };
  const stale =
    hmacSecret(account.email.toLowerCase(), input.config.authSecret) !== token.email_hash ||
    (token.kind === 'password_reset' &&
      (await passwordFingerprint(client, account.id)) !== token.password_fingerprint);
  if (stale) {
    if (input.lock)
      await client.query('UPDATE email_link_tokens SET superseded_at=now() WHERE token_hash=$1', [
        token.token_hash,
      ]);
    return { state: 'stale' };
  }
  const refusal = await signInRefusal(client, account.id);
  if (refusal) return { state: 'refused', message: refusal };
  return { state: 'ok', account, expiresAt: token.expires_at, hold };
}

/**
 * Lock a link's account for use, in the order every account-wide change takes its locks:
 * `"user"` first, then every membership by `community_id,id`. Returns the memberships, or null
 * when the token is unknown. The token row itself is locked by {@link checkLink}.
 */
export async function lockLinkAccount(
  client: PoolClient,
  tokenHash: string
): Promise<{ userId: string; memberIds: string[] } | null> {
  const owner = await client.query<{ user_id: string }>(
    'SELECT user_id FROM email_link_tokens WHERE token_hash=$1',
    [tokenHash]
  );
  const userId = owner.rows[0]?.user_id;
  if (!userId) return null;
  const user = await client.query('SELECT 1 FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
  if (!user.rowCount) return null;
  const members = await client.query<{ id: string }>(
    'SELECT id FROM members WHERE user_id=$1 ORDER BY community_id,id FOR UPDATE',
    [userId]
  );
  return { userId, memberIds: members.rows.map((row) => row.id) };
}

/** Mark a link used. */
export async function consumeLink(client: PoolClient, tokenHash: string): Promise<void> {
  await client.query(
    'UPDATE email_link_tokens SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL',
    [tokenHash]
  );
}

/**
 * Write a new password hash for the account: overwrite its password row, or add one. Done in the
 * caller's transaction, never through Better Auth's own password update, so no Better Auth
 * account hook sees it (see `account.update.after` in auth.ts).
 */
export async function writePassword(
  client: PoolClient,
  userId: string,
  hash: string
): Promise<void> {
  const updated = await client.query(
    `UPDATE account SET password=$1,"updatedAt"=now()
     WHERE "userId"=$2 AND "providerId"='credential' RETURNING id`,
    [hash, userId]
  );
  if (!updated.rowCount)
    await client.query(
      `INSERT INTO account(id,"accountId","providerId","userId",password)
       VALUES(gen_random_uuid()::text,$1,'credential',$1,$2)`,
      [userId, hash]
    );
}

/** Record an account-wide event once in every community the account is in. */
export async function auditAccount(
  client: PoolClient,
  memberIds: readonly string[],
  action: string,
  changedFields: readonly string[]
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,changed_fields)
     SELECT community_id,id,$2,id,$3::text[] FROM members
     WHERE id=ANY($1::uuid[]) ORDER BY community_id,id`,
    [memberIds, action, changedFields]
  );
}

/**
 * Tidy the mailed-link tables (runs every minute, with mail on or off):
 *
 * - a request still pending after an hour is dropped and its typed address erased, so a plain
 *   address never outlives an hour, even on a host that turned mail off;
 * - requests are deleted after 24 hours (the per-address caps look back that far);
 * - links are deleted an hour after they expired, were used or were replaced, so a just-ended
 *   one still answers `410` rather than look unknown.
 *
 * Returns how many rows changed.
 */
export async function pruneEmailLinks(pool: Queryable, now: Date = new Date()): Promise<number> {
  const dropped = await pool.query(
    `UPDATE email_link_requests SET state='dropped',resolved_at=$1,email=NULL
     WHERE state='pending' AND created_at < $1::timestamptz - interval '1 hour'`,
    [now]
  );
  const requests = await pool.query(
    `DELETE FROM email_link_requests WHERE created_at < $1::timestamptz - interval '24 hours'`,
    [now]
  );
  const tokens = await pool.query(
    `DELETE FROM email_link_tokens
     WHERE expires_at < $1::timestamptz - interval '1 hour'
        OR consumed_at < $1::timestamptz - interval '1 hour'
        OR superseded_at < $1::timestamptz - interval '1 hour'`,
    [now]
  );
  return (dropped.rowCount ?? 0) + (requests.rowCount ?? 0) + (tokens.rowCount ?? 0);
}
