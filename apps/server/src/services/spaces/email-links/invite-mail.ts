import type { Pool, PoolClient } from 'pg';
import { plainTextMail, type ComposedMail } from '../mail/messages.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * The mail an invitation's sign-up sends (DOR-2730), one of two, the same answer on the page
 * either way: an empty account gets the finishing link, and any account in use, confirmed or not,
 * a plain notice that carries no token. Copy is the designer's; the link is the only secret.
 */

/**
 * The name a mail calls the space by: the community's own name, read from its record, or else the
 * bare hostname of the server's configured public URL (never a request's `Host`, never a port).
 */
export async function spaceNameFor(
  client: Queryable,
  communityId: string | null,
  publicUrl: string
): Promise<string> {
  if (communityId) {
    const found = await client.query<{ name: string }>('SELECT name FROM communities WHERE id=$1', [
      communityId,
    ]);
    // A space's admin chose its name, and this mail goes to any address an invitation holder
    // types: no control, bidi or zero-width characters reach a subject or body (Security S3).
    const name = found.rows[0]?.name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
    if (name) return name;
  }
  return new URL(publicUrl).hostname;
}

/**
 * Whether a reset link would set this account's first password (Security M1, DOR-2730): its
 * email was never confirmed, and it has no password, no provider sign-in, no membership and no
 * host role. That is exactly the empty account an invitation's sign-up makes. A never-confirmed
 * account that is in use (a first owner who never clicked the confirmation link, an account made
 * before mail was on) is not: its link is a reset, worded as one, with the list of what it ends.
 */
export async function firstPasswordAccount(client: Queryable, userId: string): Promise<boolean> {
  const found = await client.query<{ first: boolean }>(
    // member-kind: by-account
    `SELECT NOT u."emailVerified"
       AND NOT EXISTS (SELECT 1 FROM account a WHERE a."userId"=u.id)
       AND NOT EXISTS (SELECT 1 FROM members m WHERE m.user_id=u.id)
       AND NOT EXISTS (SELECT 1 FROM host_operators h WHERE h.user_id=u.id) AS first
     FROM "user" u WHERE u.id=$1`,
    [userId]
  );
  return found.rows[0]?.first === true;
}

/** The finishing link for a new or never-confirmed account: it sets the password and joins. */
export function finishJoiningMail(space: string, link: string): ComposedMail {
  return plainTextMail(`Finish joining ${space}`, [
    `Set a password to finish joining ${space}.`,
    // Plain text has no button: one labelled line, like the sign-in notice's.
    `Set your password: ${link}`,
    // Built as words, not one template: a template reading "join ${…}" looks like SQL naming a
    // table to the member-kind guard (member-kind-guard.test.ts).
    ["If you didn't ask to join", `${space},`, 'you can ignore this email.'].join(' ') +
      ' The link expires in 1 hour.',
  ]);
}

/** The notice for an address that already has a confirmed account: a way to sign in, no token. */
export function existingAccountMail(space: string, signInUrl: string): ComposedMail {
  return plainTextMail(`Sign in to ${space}`, [
    ['Someone tried to join', space, 'with this address, and you already have an account.'].join(
      ' '
    ),
    `Sign in: ${signInUrl}`,
    "If this wasn't you, you can ignore this email.",
  ]);
}
