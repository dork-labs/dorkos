import type { Context, Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireEmailLinkAcceptedSchema,
  CommunityWirePasswordResetRequestSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { ApiError, json, RateLimited, readJson } from '../http.js';
import { requireBrowserSession } from '../routes/account/account-password.js';
import { livePendingLink, pendingTokenHash } from '../routes/account/sign-in-link.js';
import { hmacSecret, readCookie } from '../security.js';
import { cookieOptions, linkCookieName } from '../sign-in/link-gate.js';
import { callerLimitKey, type EmailLinkLimiter } from './limiter.js';
import { EMAIL_LINK_CAPS, emailLinksUnavailable, type EmailLinkKind } from './model.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** How long one ask can keep a held sign-in alive, and the most any number of asks can. */
const HOLD_EXTENSION = "interval '15 minutes'";
const HOLD_CEILING = "interval '25 minutes'";

/** What the request routes need. */
export interface EmailLinkRequestDeps {
  pool: Pool;
  auth: CommunityAuth;
  config: CommunityConfig;
  now: () => Date;
  /** Whether this server mails links (mail on, all three composers registered). */
  on: boolean;
  limiter: EmailLinkLimiter;
  /** The caller's address, as every per-caller limit reads it. */
  peer: (c: Context) => string;
}

/** The answer every recorded request gets. */
function accepted(c: Context) {
  c.header('Cache-Control', 'no-store');
  return json(c, CommunityWireEmailLinkAcceptedSchema, { accepted: true }, 202);
}

/**
 * Queue a confirmation link for an account whose email is not confirmed yet: one pending
 * request the mail worker resolves (a sign-up, or the first owner at setup).
 */
export async function queueEmailConfirmation(
  client: Queryable,
  input: { userId: string; email: string; authSecret: string }
): Promise<void> {
  await client.query(
    `INSERT INTO email_link_requests(kind,email_hash,user_id,state)
     VALUES('email_confirmation',$1,$2,'pending')`,
    [hmacSecret(input.email.toLowerCase(), input.authSecret), input.userId]
  );
}

/**
 * Refuse a fourth request of this kind from one account within an hour. Honest, because the
 * caller already knows the account exists: they hold its sign-in or its session.
 */
async function limitAccount(client: Queryable, userId: string, kind: EmailLinkKind) {
  const recent = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM email_link_requests
     WHERE user_id=$1 AND kind=$2 AND created_at > now() - interval '1 hour'`,
    [userId, kind]
  );
  if (recent.rows[0].n >= EMAIL_LINK_CAPS.perAccountPerHour)
    throw new RateLimited('Too many emails. Try again in an hour.', 3600);
}

/**
 * Register the three routes that ask for a mailed link, on the host API. None of them sends mail
 * or mints a link: each records one request row, and the mail worker's resolver decides later
 * whether it becomes mail (`email-links/resolver.ts`).
 *
 * `POST /account/password-reset` is anonymous and answers the same `202` for every address, by
 * the same single statement, with no read of `"user"` and no count: the answer and its timing are
 * a function of the request alone. Its only limits are per caller address (an IPv6 /64), a minute
 * and an hour, in the mailed links' own memory. Per-address and host-wide caps are the resolver's.
 *
 * `POST /sign-in-link/email` mails a sign-in link to the account a held sign-in matched (the
 * DOR-2709 link screen), for this browser only. `POST /account/email-confirmation` mails the
 * signed-in account a confirmation link.
 */
export function registerEmailLinkRequestRoutes(app: Hono, deps: EmailLinkRequestDeps): void {
  const { pool, auth, config, now } = deps;
  const limitCaller = (c: Context) =>
    deps.limiter.spend(`email-link-request:${callerLimitKey(deps.peer(c))}`, {
      perMinute: config.limits.emailLinkRequestsPerMinute,
      perHour: EMAIL_LINK_CAPS.perCallerPerHour,
    });

  app.post('/account/password-reset', async (c) => {
    if (!deps.on) throw emailLinksUnavailable();
    limitCaller(c);
    const { email } = await readJson(c, CommunityWirePasswordResetRequestSchema);
    await pool.query(
      `INSERT INTO email_link_requests(kind,email_hash,email,state)
       VALUES('password_reset',$1,$2,'pending')`,
      [hmacSecret(email, config.authSecret), email]
    );
    return accepted(c);
  });

  app.post('/sign-in-link/email', async (c) => {
    if (!deps.on) throw emailLinksUnavailable();
    limitCaller(c);
    const cookieHeader = c.req.header('cookie') ?? null;
    const tokenHash = pendingTokenHash(cookieHeader, config);
    const expired = () =>
      new ApiError(410, 'LINK_EXPIRED', 'This sign-in took too long. Sign in again.');
    const expiresAt = await transaction(pool, async (client) => {
      const pending = await livePendingLink(client, tokenHash, now(), { lock: true });
      if (!pending) throw expired();
      const user = await client.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1', [
        pending.user_id,
      ]);
      if (!user.rows[0]) throw expired();
      await limitAccount(client, pending.user_id, 'sign_in');
      await client.query(
        `INSERT INTO email_link_requests(kind,email_hash,user_id,pending_link_hash,state)
         VALUES('sign_in',$1,$2,$3,'pending')`,
        [
          hmacSecret(user.rows[0].email.toLowerCase(), config.authSecret),
          pending.user_id,
          pending.token_hash,
        ]
      );
      // The hold must outlive the mail it waits for, but repeated asks cannot keep it alive past
      // 25 minutes from when it began.
      const extended = await client.query<{ expires_at: Date }>(
        `UPDATE pending_sign_in_links
         SET expires_at=LEAST(created_at + ${HOLD_CEILING}, $2::timestamptz + ${HOLD_EXTENSION})
         WHERE token_hash=$1 RETURNING expires_at`,
        [pending.token_hash, now()]
      );
      return extended.rows[0].expires_at;
    });
    // The browser's cookie must live exactly as long as the hold it carries.
    const signed = readCookie(cookieHeader, linkCookieName(config))!;
    const options = cookieOptions(config, Math.max(0, expiresAt.getTime() - now().getTime()));
    setCookie(c, linkCookieName(config), signed, { ...options, sameSite: 'Lax' });
    return accepted(c);
  });

  app.post('/account/email-confirmation', async (c) => {
    if (!deps.on) throw emailLinksUnavailable();
    limitCaller(c);
    const session = await requireBrowserSession(c, auth);
    await transaction(pool, async (client) => {
      const user = await client.query<{ email: string; emailVerified: boolean }>(
        'SELECT email,"emailVerified" FROM "user" WHERE id=$1 FOR UPDATE',
        [session.user.id]
      );
      const row = user.rows[0];
      if (!row) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      if (row.emailVerified)
        throw new ApiError(409, 'STATE_CONFLICT', 'This email is already confirmed.');
      await limitAccount(client, session.user.id, 'email_confirmation');
      await queueEmailConfirmation(client, {
        userId: session.user.id,
        email: row.email,
        authSecret: config.authSecret,
      });
    });
    return accepted(c);
  });
}
