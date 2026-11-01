import type { Pool, PoolClient } from 'pg';
import { plainTextMail, type ComposedMail } from '../mail/messages.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * The mail an invitation's sign-up sends (DOR-2730), one of two, the same answer on the page
 * either way: a new or never-confirmed account gets the finishing link, and a confirmed account
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
    const name = found.rows[0]?.name.trim();
    if (name) return name;
  }
  return new URL(publicUrl).hostname;
}

/** The finishing link for a new or never-confirmed account: it sets the password and joins. */
export function finishJoiningMail(space: string, link: string): ComposedMail {
  return plainTextMail(`Finish joining ${space}`, [
    `Set a password to finish joining ${space}.`,
    // Plain text has no button: one labelled line, like the sign-in notice's.
    `Set your password: ${link}`,
    `If you didn't ask to join ${space}, you can ignore this email. The link expires in 1 hour.`,
  ]);
}

/** The notice for an address that already has a confirmed account: a way to sign in, no token. */
export function existingAccountMail(space: string, signInUrl: string): ComposedMail {
  return plainTextMail(`Sign in to ${space}`, [
    `Someone tried to join ${space} with this address, and you already have an account.`,
    `Sign in: ${signInUrl}`,
    "If this wasn't you, you can ignore this email.",
  ]);
}
