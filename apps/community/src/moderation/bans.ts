import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../http.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Domains whose mailboxes ignore dots in the local part. */
const DOTLESS_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The form of an address a ban is keyed by, so the same mailbox written another way meets the
 * same ban: lower case, trimmed, with any `+tag` dropped, and for Gmail no dots and the one
 * domain. A ban is a speed bump, not a wall: a different mailbox still gets in.
 *
 * @param email - The address as the account holds it.
 * @returns The normalised address; an address without `@` is only trimmed and lower-cased.
 */
export function normaliseBanEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (DOTLESS_DOMAINS.has(domain)) {
    local = local.replaceAll('.', '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/**
 * The key a ban stores for an email: an HMAC-SHA256 of the normalised address, keyed with the
 * deployment's auth secret. An address can be guessed, so an unkeyed hash would confirm a guess;
 * this one is useless without the secret. The `community-ban:` prefix keeps it apart from every
 * other use of that secret.
 *
 * @param email - The address as the account holds it.
 * @param secret - The deployment's auth secret.
 * @returns 64 lower-case hex characters.
 */
export function banEmailKey(email: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`community-ban:${normaliseBanEmail(email)}`)
    .digest('hex');
}

/** The refusal every way back in gives a banned person. It says no more than that. */
export function bannedRefusal(): ApiError {
  return new ApiError(403, 'FORBIDDEN', "You can't join this space.");
}

/**
 * Whether a standing ban in `communityId` names this account, or this email under its key.
 *
 * @param db - A pool or a transaction client.
 * @param communityId - The community the person is trying to enter.
 * @param who - The account, its email, or both; either one matching is a ban.
 * @param secret - The deployment's auth secret, which keys the email.
 */
export async function isBanned(
  db: Queryable,
  communityId: string,
  who: { userId?: string | null; email?: string | null },
  secret: string
): Promise<boolean> {
  const emailKey = who.email ? banEmailKey(who.email, secret) : null;
  if (!who.userId && !emailKey) return false;
  const result = await db.query(
    `SELECT 1 FROM bans WHERE community_id=$1 AND lifted_at IS NULL
       AND (user_id=$2 OR email_hash=$3) LIMIT 1`,
    [communityId, who.userId ?? null, emailKey]
  );
  return Boolean(result.rowCount);
}

/**
 * Refuse a banned account, reading its email from the account itself. The email counts only
 * once it is confirmed: anyone can type someone else's address into a password sign-up, so an
 * unconfirmed one is not evidence of who the person is, and the account itself is checked.
 *
 * Call it after locking the member row the admission will write: a ban takes the community row
 * for update (`routes/community/bans.ts`), and every admission holds that row for share, so a
 * ban either commits before this read or waits for the admission to commit and then removes it.
 *
 * @throws {ApiError} 403 when a standing ban names the account or its confirmed email.
 */
export async function refuseBannedAccount(
  db: Queryable,
  communityId: string,
  userId: string,
  secret: string
): Promise<void> {
  const account = await db.query<{ email: string; verified: boolean }>(
    'SELECT email,"emailVerified" AS verified FROM "user" WHERE id=$1',
    [userId]
  );
  const row = account.rows[0];
  if (await isBanned(db, communityId, { userId, email: row?.verified ? row.email : null }, secret))
    throw bannedRefusal();
}
