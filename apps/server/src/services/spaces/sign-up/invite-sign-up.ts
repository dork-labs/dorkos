import { randomBytes } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CommunityWirePasswordResetRequestSchema } from '@dorkos/shared/community-wire';
import { transaction } from '../data.js';
import { EXISTING_ACCOUNT_REQUEST } from '../email-links/model.js';
import { hashSecret, hmacSecret, readCookie, verifyValue } from '../security.js';

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
 * The mail differs, and only the mailbox's owner sees it. An empty account gets the finishing
 * link ("Finish joining {space}"): it sets the password, confirms the email, clears every other
 * way in and signs the browser in, so someone who typed another person's address gains nothing
 * (`email-links/plugin.ts`). An account in use gets the usual reset mail, and a confirmed one a
 * plain notice ("Sign in to {space}") with no token, so a member who chose sign-up by mistake is
 * never sent a reset that would end their sessions and keys (`email-links/composers.ts`). With no
 * password stored, a password sign-in to the new account fails exactly as one to a taken address
 * with the wrong password does.
 *
 * Owner grants and claims (each held by one person) and hosts without mail keep Better Auth's
 * own sign-up, which still answers `422` for a taken address there.
 */
const BodySchema = z.object({
  // Stored as the account's name: no control or invisible formatting characters, and a cap.
  name: z
    .string()
    .transform((value) => value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim())
    .pipe(z.string().min(1).max(100)),
  // The reset route's own rule: trimmed, lower-cased, at most 320 characters.
  email: CommunityWirePasswordResetRequestSchema.shape.email,
});

type Queryable = Pick<Pool | PoolClient, 'query'>;

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

/**
 * The space this browser's live invitation is for, from the server's own HttpOnly join attempt
 * (`community_admission`), or null. The invitation must be unexpired and unrevoked, its issuer
 * still an active owner or admin, and its space active. Never read from a request body.
 */
export async function invitationSpace(
  client: Queryable,
  cookieHeader: string | null,
  authSecret: string
): Promise<string | null> {
  const pending = verifyValue(readCookie(cookieHeader, 'community_admission'), authSecret);
  if (!pending) return null;
  const result = await client.query<{ community_id: string }>(
    // member-kind: named-member
    `SELECT i.community_id FROM pending_admissions p JOIN invites i ON i.id=p.invite_id
     JOIN members m ON m.id=i.issuer_member_id
     JOIN communities c ON c.id=i.community_id
     WHERE p.token_hash=$1 AND p.expires_at>now() AND i.expires_at>now()
       AND i.revoked_at IS NULL
       AND c.lifecycle='active' AND m.active AND m.role IN ('owner','admin')`,
    [hashSecret(pending)]
  );
  return result.rows[0]?.community_id ?? null;
}

/**
 * Queue an invitation's mail for one address, by the same two statements whatever the address.
 * Only an empty account (never confirmed, and no password, provider sign-in, membership or host
 * role) is asked the finishing link. Any account in use, confirmed or not (a first owner who
 * never confirmed, say), is asked the existing-account notice with no token: never a reset,
 * which would end its sessions and keys (Security M1, designer). An address with no account is
 * asked the link, which the resolver then drops. Sign-up and Resend both queue this way, so both
 * share the space, the notice and the per-address cap.
 */
export async function queueInviteMail(
  client: Queryable,
  input: { email: string; communityId: string; authSecret: string }
): Promise<void> {
  const account = await client.query<{ first: boolean }>(
    // member-kind: by-account
    `SELECT NOT u."emailVerified"
       AND NOT EXISTS (SELECT 1 FROM account a WHERE a."userId"=u.id)
       AND NOT EXISTS (SELECT 1 FROM members m WHERE m.user_id=u.id)
       AND NOT EXISTS (SELECT 1 FROM host_operators h WHERE h.user_id=u.id) AS first
     FROM "user" u WHERE u.email=$1`,
    [input.email]
  );
  const inUse = account.rows[0] !== undefined && !account.rows[0].first;
  await client.query(
    `INSERT INTO email_link_requests(kind,email_hash,email,community_id,state)
     VALUES($1,$2,$3,$4,'pending')`,
    [
      inUse ? EXISTING_ACCOUNT_REQUEST : 'password_reset',
      hmacSecret(input.email, input.authSecret),
      input.email,
      input.communityId,
    ]
  );
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
  const { name, email } = parsed.data;
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
    // A taken address, or one taken a moment ago by a request racing this one, inserts nothing.
    // A new account is never confirmed, so the mail queued next is its finishing link.
    await client.query(
      `INSERT INTO "user"(id,name,email,"emailVerified",image,"createdAt","updatedAt")
       VALUES($1,$2,$3,false,NULL,$4,$4) ON CONFLICT (email) DO NOTHING`,
      [user.id, name, email, now]
    );
    await queueInviteMail(client, {
      email,
      communityId: input.communityId,
      authSecret: input.authSecret,
    });
  });
  return user;
}
