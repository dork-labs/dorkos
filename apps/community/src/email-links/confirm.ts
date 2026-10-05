import type { Context, Hono } from 'hono';
import { hashPassword } from 'better-auth/crypto';
import type { Pool } from 'pg';
import {
  CommunityWireEmailConfirmRequestSchema,
  CommunityWireEmailConfirmResponseSchema,
  CommunityWireEmailLinkPeekSchema,
  CommunityWireEmailLinkTokenRequestSchema,
  type CommunityWireEmailLinkKind,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { ApiError, json, readJson } from '../http.js';
import { requireBrowserSession } from '../routes/account/account-password.js';
import { pendingTokenHash } from '../routes/account/sign-in-link.js';
import { hashSecret } from '../security.js';
import { clearAccountAccess } from '../sign-in/account-access.js';
import { markAccessCleared } from '../sign-in/request-start.js';
import { clearsFor, emailLinksUnavailable } from './model.js';
import {
  auditAccount,
  checkLink,
  consumeLink,
  lockLinkAccount,
  needsNewPassword,
  writePassword,
} from './tokens.js';

const EXPIRED = 'This link expired or was already used.';

function gone(message = EXPIRED) {
  return new ApiError(410, 'LINK_EXPIRED', message);
}

/** What the peek and confirm routes need. */
export interface EmailLinkUseDeps {
  pool: Pool;
  auth: CommunityAuth;
  config: CommunityConfig;
  /** Whether this server mails links; off, both routes answer `409`. */
  on: boolean;
}

/** The kind a token was minted as, read without a lock, or null when it is unknown. */
async function tokenKind(
  pool: Pool,
  tokenHash: string
): Promise<CommunityWireEmailLinkKind | null> {
  const row = await pool.query<{ kind: CommunityWireEmailLinkKind }>(
    'SELECT kind FROM email_link_tokens WHERE token_hash=$1',
    [tokenHash]
  );
  return row.rows[0]?.kind ?? null;
}

/** This browser's own signed-in account, if any; never a grant, agent or host key. */
async function signedInAs(c: Context, auth: CommunityAuth) {
  if (c.req.header('authorization')) return null;
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session ? { email: session.user.email, method: null } : null;
}

/**
 * Register the routes a mailed link's page calls, on the host API.
 *
 * `POST /email-links/peek` reads a link before it is used, and uses nothing up: what it does,
 * the address it was sent to (so the page can say whose account it is, before anything happens),
 * what using it ends (`clears`, listed before the person submits), whether a confirmation needs a
 * new password, and who this browser is signed in as now. A link that cannot be used is `410`.
 *
 * `POST /account/email-confirmation/confirm` confirms the signed-in account's email. The link
 * alone is not enough: it must be used by a session of the same account. A squatter who made an
 * account with someone else's address holds a session but not the mailbox; the address's owner
 * holds the mailbox but not the session. Neither can confirm alone. Confirming an email that was
 * never confirmed also ends every other session and every derived credential, and needs a new
 * password when the account has one, because a squatter can simply hand the owner the password.
 */
export function registerEmailLinkUseRoutes(app: Hono, deps: EmailLinkUseDeps): void {
  const { pool, auth, config } = deps;

  app.post('/email-links/peek', async (c) => {
    if (!deps.on) throw emailLinksUnavailable();
    c.header('Cache-Control', 'no-store');
    const { token } = await readJson(c, CommunityWireEmailLinkTokenRequestSchema);
    const tokenHash = hashSecret(token);
    const kind = await tokenKind(pool, tokenHash);
    if (!kind) throw gone();
    const check = await checkLink(pool, {
      tokenHash,
      kind,
      config,
      pendingHash: pendingTokenHash(c.req.header('cookie') ?? null, config),
      lock: false,
    });
    if (check.state === 'refused') throw new ApiError(403, 'SIGN_IN_REFUSED', check.message);
    if (check.state !== 'ok') throw gone();
    const confirmed = check.account.emailVerified;
    return json(c, CommunityWireEmailLinkPeekSchema, {
      kind,
      email: check.account.email,
      expiresAt: check.expiresAt.toISOString(),
      clears: clearsFor(kind, confirmed),
      needsPassword:
        kind === 'email_confirmation' &&
        !confirmed &&
        (await needsNewPassword(pool, check.account.id)),
      signedInAs: await signedInAs(c, auth),
    });
  });

  app.post('/account/email-confirmation/confirm', async (c) => {
    if (!deps.on) throw emailLinksUnavailable();
    const session = await requireBrowserSession(c, auth);
    const body = await readJson(c, CommunityWireEmailConfirmRequestSchema);
    // Hashed before any lock is taken: the hasher is deliberately slow.
    const hash = body.newPassword === undefined ? null : await hashPassword(body.newPassword);
    const tokenHash = hashSecret(body.token);
    const outcome = await transaction(pool, async (client) => {
      const locked = await lockLinkAccount(client, tokenHash);
      if (!locked) return { refusal: gone() };
      // Someone else's link: refused before it is even checked, so it stays as it was.
      if (locked.userId !== session.user.id)
        throw new ApiError(403, 'FORBIDDEN', 'This link is for another account.');
      const check = await checkLink(client, {
        tokenHash,
        kind: 'email_confirmation',
        config,
        pendingHash: null,
        lock: true,
      });
      if (check.state === 'refused') throw new ApiError(403, 'SIGN_IN_REFUSED', check.message);
      if (check.state !== 'ok') return { refusal: gone() };
      const userId = check.account.id;
      if (check.account.emailVerified) {
        await consumeLink(client, tokenHash);
        return { cleared: 'none' as const, xid: null };
      }
      if (hash === null && (await needsNewPassword(client, userId)))
        throw new ApiError(400, 'PASSWORD_REQUIRED', 'Choose a new password to confirm.');
      if (hash !== null) await writePassword(client, userId, hash);
      await consumeLink(client, tokenHash);
      await client.query(
        `UPDATE email_link_tokens SET superseded_at=now()
         WHERE user_id=$1 AND kind='email_confirmation' AND consumed_at IS NULL
           AND superseded_at IS NULL`,
        [userId]
      );
      const { xid } = await clearAccountAccess(
        client,
        userId,
        locked.memberIds,
        { password: true, links: true, sessionId: session.session.id },
        'system'
      );
      await client.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [userId]);
      await auditAccount(client, locked.memberIds, 'member.email_confirmed', ['link']);
      if (hash !== null)
        await auditAccount(client, locked.memberIds, 'member.password_reset', [
          'password',
          'confirm',
        ]);
      return { cleared: 'others' as const, xid };
    });
    if ('refusal' in outcome) throw outcome.refusal;
    if (outcome.xid) markAccessCleared(session.user.id, outcome.xid);
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireEmailConfirmResponseSchema, {
      confirmed: true,
      cleared: outcome.cleared,
    });
  });
}
