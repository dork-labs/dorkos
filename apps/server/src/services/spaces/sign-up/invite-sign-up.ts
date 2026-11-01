import { randomBytes } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../data.js';
import { EXISTING_ACCOUNT_REQUEST } from '../email-links/model.js';
import { hmacSecret } from '../security.js';

/**
 * Sign-up through an invitation, on a host that mails links (DOR-2730).
 *
 * Better Auth's own password sign-up answers `422 USER_ALREADY_EXISTS` for a taken address and
 * signs a new one straight in, so anyone holding an invitation could test which addresses have
 * accounts. This sign-up takes a name and an email only, and answers the same way for both:
 *
 * - a new address gets an account with no password, no session and an unconfirmed email; a taken
 *   one gets nothing new;
 * - both run one throwaway password hash, so they cost the same time, and the same statements:
 *   both write one mail request for the address, naming the invitation's space;
 * - both answer `200 { token: null, user }` with a user built the same way (for a taken address
 *   the id is made up and stored nowhere).
 *
 * The mail differs, and only the mailbox's owner sees it. A new or never-confirmed account gets
 * the finishing link ("Finish joining {space}"): it sets the password, confirms the email, clears
 * every other way in and signs the browser in, so someone who typed another person's address
 * gains nothing (`email-links/plugin.ts`). A confirmed account gets a plain notice ("Sign in to
 * {space}") with no token, so a member who chose sign-up by mistake is never sent a reset that
 * would end their sessions and keys. With no password stored, a password sign-in to the new
 * account fails exactly as one to a taken address with the wrong password does.
 */
const BodySchema = z.object({
  name: z.string().trim().min(1),
  email: z.email(),
});

/** The user object both answers carry: the same fields, built the same way. */
export interface InviteSignUpUser {
  id: string;
  name: string;
  email: string;
  emailVerified: false;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Make the account (or, for a taken address, nothing) and queue its mail. */
export async function inviteSignUp(
  pool: Pool,
  input: { authSecret: string; communityId: string; body: unknown; generateId: () => string }
): Promise<InviteSignUpUser> {
  const parsed = BodySchema.safeParse(input.body);
  if (!parsed.success)
    throw new APIError('BAD_REQUEST', {
      code: 'VALIDATION_ERROR',
      message: 'Enter your name and email.',
    });
  const { name } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  // The same deliberately slow hash on both branches, so neither answers faster. Nothing keeps it.
  await hashPassword(randomBytes(32).toString('base64url'));
  const now = new Date();
  const user: InviteSignUpUser = {
    id: input.generateId(),
    name,
    email,
    emailVerified: false,
    // No picture at sign-up: one chosen by whoever typed the address must not stay on its account.
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  await transaction(pool, async (client) => {
    const existing = await client.query<{ emailVerified: boolean }>(
      'SELECT "emailVerified" FROM "user" WHERE email=$1',
      [email]
    );
    const confirmed = existing.rows[0]?.emailVerified === true;
    // A taken address, or one taken a moment ago by a request racing this one, inserts nothing.
    await client.query(
      `INSERT INTO "user"(id,name,email,"emailVerified",image,"createdAt","updatedAt")
       VALUES($1,$2,$3,false,NULL,$4,$4) ON CONFLICT (email) DO NOTHING`,
      [user.id, name, email, now]
    );
    // One statement for both: only which mail it asks for differs.
    await client.query(
      `INSERT INTO email_link_requests(kind,email_hash,email,community_id,state)
       VALUES($1,$2,$3,$4,'pending')`,
      [
        confirmed ? EXISTING_ACCOUNT_REQUEST : 'password_reset',
        hmacSecret(email, input.authSecret),
        email,
        input.communityId,
      ]
    );
  });
  return user;
}
