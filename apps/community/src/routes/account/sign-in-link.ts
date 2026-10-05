import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireSignInLinkNoticeSchema,
  CommunityWireSignInLinkRequestSchema,
  CommunityWireSignInLinkResponseSchema,
  type CommunityWireSignInLinkNotice,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { transaction } from '../../data.js';
import { signInRefusal } from '../../erasure/guards.js';
import { ApiError, json, readJson } from '../../http.js';
import type { CheckAccountPassword } from '../../password-confirmation.js';
import type { NoticeKind } from '../../mail/outbox.js';
import { hashSecret, readCookie, verifyValue } from '../../security.js';
import { LINK_NOTICE_COOKIE, linkCookieName, signInHoldOnly } from '../../sign-in/link-gate.js';
import { recordSignInLinked, signInName } from '../../sign-in/linked.js';

/** One sign-in waiting for the matched account's password. */
export interface PendingLink {
  token_hash: string;
  user_id: string;
  provider_id: string;
  account_id: string;
}

const expired = () =>
  new ApiError(410, 'LINK_EXPIRED', 'This sign-in link expired. Sign in again.');

/** Forget a cookie this browser holds. */
export function clearCookie(c: Context, config: CommunityConfig, name: string) {
  setCookie(c, name, '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.publicUrl.startsWith('https:'),
    path: '/',
    maxAge: 0,
  });
}

/**
 * The hash of the pending-link token this browser holds, or null when it holds no valid one.
 * Read only under {@link linkCookieName}: on HTTPS, the `__Host-` cookie and never the plain one.
 */
export function pendingTokenHash(
  cookieHeader: string | null,
  config: Pick<CommunityConfig, 'publicUrl' | 'authSecret'>
): string | null {
  const token = verifyValue(readCookie(cookieHeader, linkCookieName(config)), config.authSecret);
  return token ? hashSecret(token) : null;
}

/** The live pending link this browser holds: signed, unexpired and unused. */
export async function livePendingLink(
  client: Pick<Pool | PoolClient, 'query'>,
  tokenHash: string | null,
  now: Date,
  { lock = false } = {}
): Promise<PendingLink | null> {
  if (!tokenHash) return null;
  const row = await client.query<PendingLink>(
    `SELECT token_hash,user_id,provider_id,account_id FROM pending_sign_in_links
     WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>$2 AND ${signInHoldOnly}
     ${lock ? 'FOR UPDATE' : ''}`,
    [tokenHash, now]
  );
  return row.rows[0] ?? null;
}

/** The account's password hash, or null when it signs in only through a provider. */
async function passwordHash(
  client: Pick<Pool | PoolClient, 'query'>,
  userId: string
): Promise<string | null> {
  const row = await client.query<{ password: string | null }>(
    `SELECT password FROM account WHERE "userId"=$1 AND "providerId"='credential'`,
    [userId]
  );
  return row.rows[0]?.password ?? null;
}

/**
 * Register the routes that finish a provider sign-in whose email matched an existing account
 * (see `sign-in/link-gate.ts`), on the host API.
 *
 * `POST /sign-in-link` takes the matched account's password. It spends from the same
 * per-account guess budget every other password check spends from (`reauth-account:<userId>`),
 * so guesses never add up across routes; once spent, the waiting sign-in is used up too, and
 * another try needs a fresh trip through the provider. A right password links the sign-in in one
 * transaction that re-checks, under the account's lock, that the password is still the one just
 * checked and the waiting sign-in still unused, then signs the browser in through Better Auth's
 * own password sign-in, so the session is exactly a normal sign-in's.
 *
 * `DELETE /sign-in-link` cancels the waiting sign-in. `GET /sign-in-link/notice` says, once,
 * what the sign-in page should show about linking.
 */
export function registerSignInLinkRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    now: () => Date;
    /** The account password check, on the shared per-account guess budget. */
    checkPassword: CheckAccountPassword;
    /** Whether mail is set up and the worker can compose this kind of notice. */
    canSendNotice: (kind: NoticeKind) => boolean;
    /** Test-only pauses: after the password checks out, and after the link commits. */
    hooks?: { afterPasswordCheck?: () => Promise<void>; afterLinked?: () => Promise<void> };
  }
): void {
  const { pool, auth, config, now } = deps;

  app.post('/sign-in-link', async (c) => {
    c.header('Cache-Control', 'no-store');
    const tokenHash = pendingTokenHash(c.req.header('cookie') ?? null, config);
    const pending = await livePendingLink(pool, tokenHash, now());
    if (!pending) throw expired();
    const body = await readJson(c, CommunityWireSignInLinkRequestSchema);
    const hash = await passwordHash(pool, pending.user_id);
    // Nothing is spent: no guess runs against an account with no password.
    if (!hash)
      throw new ApiError(
        403,
        'PASSWORD_REQUIRED',
        "This account has no password. Ask the space's owner for help."
      );
    await deps.checkPassword({
      accountId: pending.user_id,
      hash,
      password: body.password,
      // Out of guesses: this waiting sign-in is used up as well.
      onLimited: async () => {
        await pool.query(
          'UPDATE pending_sign_in_links SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL',
          [pending.token_hash]
        );
        clearCookie(c, config, linkCookieName(config));
      },
    });
    await deps.hooks?.afterPasswordCheck?.();

    const email = await transaction(pool, async (client) => {
      const user = await client.query<{ email: string }>(
        'SELECT email FROM "user" WHERE id=$1 FOR UPDATE',
        [pending.user_id]
      );
      if (!user.rows[0]) throw expired();
      // The password changed, or the account lost it, between the check and now.
      if ((await passwordHash(client, pending.user_id)) !== hash) throw expired();
      const still = await livePendingLink(client, pending.token_hash, now(), { lock: true });
      if (!still) throw expired();
      await client.query('UPDATE pending_sign_in_links SET consumed_at=now() WHERE token_hash=$1', [
        pending.token_hash,
      ]);
      const refusal = await signInRefusal(client, pending.user_id);
      if (refusal) throw new ApiError(403, 'FORBIDDEN', refusal);
      const members = await client.query<{ id: string }>(
        'SELECT id FROM members WHERE user_id=$1 ORDER BY community_id,id FOR UPDATE',
        [pending.user_id]
      );
      const taken = await client.query(
        `SELECT 1 FROM account WHERE "providerId"=$1 AND "accountId"=$2`,
        [pending.provider_id, pending.account_id]
      );
      if (taken.rowCount) throw alreadyLinked();
      try {
        await client.query(
          `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,$2,$3,$4)`,
          [randomUUID(), pending.account_id, pending.provider_id, pending.user_id]
        );
      } catch (cause) {
        // Another sign-in linked the same identity first; the unique key decides.
        if ((cause as { code?: string }).code === '23505') throw alreadyLinked();
        throw cause;
      }
      await recordSignInLinked(client, {
        userId: pending.user_id,
        memberIds: members.rows.map((row) => row.id),
        changedFields: [pending.provider_id, 'password'],
        notice: deps.canSendNotice('account.sign_in_linked'),
        now: now(),
      });
      return user.rows[0].email;
    });
    clearCookie(c, config, linkCookieName(config));
    await deps.hooks?.afterLinked?.();

    // Signed in exactly as a password sign-in is: Better Auth's own session hooks and cookie.
    const signedIn = await auth.api.signInEmail({
      body: { email, password: body.password },
      headers: c.req.raw.headers,
      asResponse: true,
    });
    if (!signedIn.ok)
      throw new ApiError(
        403,
        'FORBIDDEN',
        'The sign-in is linked, but you could not be signed in. Sign in again.'
      );
    for (const cookie of signedIn.headers.getSetCookie())
      c.header('Set-Cookie', cookie, { append: true });
    return json(c, CommunityWireSignInLinkResponseSchema, { linked: true });
  });

  app.delete('/sign-in-link', async (c) => {
    const tokenHash = pendingTokenHash(c.req.header('cookie') ?? null, config);
    if (tokenHash)
      await pool.query(
        'UPDATE pending_sign_in_links SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL',
        [tokenHash]
      );
    clearCookie(c, config, linkCookieName(config));
    return c.body(null, 204);
  });

  app.get('/sign-in-link/notice', async (c) => {
    c.header('Cache-Control', 'no-store');
    const cookieHeader = c.req.header('cookie') ?? null;
    const linked = verifyValue(readCookie(cookieHeader, LINK_NOTICE_COOKIE), config.authSecret);
    let notice: CommunityWireSignInLinkNotice = { state: 'none', provider: null };
    if (linked === 'linked' || linked === 'linked_cleared') {
      // Said once: a reload does not say it again.
      clearCookie(c, config, LINK_NOTICE_COOKIE);
      notice = {
        state: linked === 'linked' ? 'linked' : 'linkedCleared',
        // Only the host's own issuer links without a password.
        provider: signInName('oidc', config),
      };
    } else {
      const pending = await livePendingLink(
        pool,
        pendingTokenHash(c.req.header('cookie') ?? null, config),
        now()
      );
      if (pending) notice = { state: 'pending', provider: signInName(pending.provider_id, config) };
    }
    return json(c, CommunityWireSignInLinkNoticeSchema, notice);
  });
}

function alreadyLinked() {
  return new ApiError(409, 'ALREADY_LINKED', 'That sign-in is already linked to an account here.');
}
