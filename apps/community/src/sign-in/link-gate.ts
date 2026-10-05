import { APIError, getOAuthState } from 'better-auth/api';
import type { Pool, PoolClient } from 'pg';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { signInRefusal } from '../erasure/guards.js';
import type { NoticeKind } from '../mail/outbox.js';
import { OIDC_PROVIDER_ID } from '../oidc.js';
import { hashSecret, randomToken, signValue } from '../security.js';
import { clearAccountAccess } from './account-access.js';
import { recordSignInLinked } from './linked.js';
import { markAccessCleared } from './request-start.js';

/** The cookie that carries a sign-in waiting for the matched account's password (plain HTTP). */
export const PENDING_LINK_COOKIE = 'community_pending_link';

/**
 * The name of the cookie that carries a held sign-in: `__Host-community_pending_link` on an
 * HTTPS host, `community_pending_link` on a plain-HTTP development host. Every read and write
 * goes through this one helper.
 *
 * The `__Host-` prefix makes a browser accept the cookie only with `Secure`, `Path=/` and no
 * `Domain`, set by this very host, so a sibling subdomain cannot plant one ("cookie tossing")
 * and have the victim's mailed sign-in link complete the attacker's held identity. On an HTTPS
 * host a cookie under the unprefixed name is never read.
 */
export function linkCookieName(config: Pick<CommunityConfig, 'publicUrl'>): string {
  return config.publicUrl.startsWith('https:')
    ? `__Host-${PENDING_LINK_COOKIE}`
    : PENDING_LINK_COOKIE;
}

/**
 * The SQL predicate that keeps a pending link to a sign-in hold, ANDed into every query that
 * reads one for the mailed sign-in path (the request route, the resolver and the use). Today
 * every row is a sign-in hold, so it is `TRUE`; a later kind of hold (a Settings link, DOR-2711)
 * narrows it to its own purpose, so mail never approves a hold meant for a signed-in session.
 */
export const signInHoldOnly = 'TRUE';
/** The cookie that tells the next page a trusted sign-in was linked, read once. */
export const LINK_NOTICE_COOKIE = 'community_link_notice';
/** How long a sign-in waits for the matched account's password, and the cookie lives. */
export const PENDING_LINK_TTL_MS = 10 * 60_000;

/** The code a refused sign-in redirects with, so every provider callback lands on the page. */
export const SIGN_IN_REFUSED_CODE = 'sign_in_refused';
/** The code a held sign-in redirects with: the page asks for the matched account's password. */
export const LINK_NEEDS_PASSWORD_CODE = 'link_needs_password';

/** What the gate does with one account row Better Auth is about to create. */
export type LinkDecision =
  /** Not a link to an existing account: a password row, a sign-up, or a Settings link. */
  | 'allow'
  /** The host's trusted issuer: link now, clearing a never-confirmed account first. */
  | 'trusted'
  /** Any other provider: hold the sign-in until the account's password is proven. */
  | 'password';

/**
 * Decide what one account row is, in order: a password row; the account row of a sign-up in
 * this same request; a link the signed-in account started from Settings (only an authenticated
 * `/link-social` can put `link` in the OAuth state, so a session cookie alone never counts);
 * otherwise an implicit link on sign-in, which only the host's own OIDC issuer, with
 * `COMMUNITY_OIDC_LINK_VERIFIED_EMAIL=1`, may make without the account's password. Google and
 * GitHub never may.
 */
export function decideLink(input: {
  providerId: string;
  /** Whether this request already created the user the row belongs to (a sign-up). */
  creatingUser: boolean;
  /** The account a Settings link started for, from the callback's OAuth state, if any. */
  settingsLinkUserId: string | null;
  userId: string;
  /** `COMMUNITY_OIDC_LINK_VERIFIED_EMAIL=1` for the host's issuer. */
  trustOidc: boolean;
}): LinkDecision {
  if (input.providerId === 'credential') return 'allow';
  if (input.creatingUser) return 'allow';
  if (input.settingsLinkUserId !== null && input.settingsLinkUserId === input.userId)
    return 'allow';
  return input.providerId === OIDC_PROVIDER_ID && input.trustOidc ? 'trusted' : 'password';
}

/** The account a Settings link started for, read from the callback's verified OAuth state. */
async function settingsLinkUserId(): Promise<string | null> {
  try {
    const state = (await getOAuthState()) as { link?: { userId?: unknown } } | null;
    const userId = state?.link?.userId;
    return typeof userId === 'string' ? userId : null;
  } catch {
    // No OAuth state in this request: not a provider callback at all.
    return null;
  }
}

type CookieOptions = {
  path: string;
  maxAge: number;
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
};
/** The part of Better Auth's endpoint context the gate uses. */
export interface LinkGateContext {
  setCookie(name: string, value: string, options?: CookieOptions): unknown;
}

/** The trusted link each request made, waiting for its account row to exist. */
const trustedLinks = new WeakMap<object, LinkGateAccount & { cleared: boolean }>();

/**
 * Once Better Auth has created an account row (`databaseHooks.account.create.after`), finish the
 * trusted link this request made, if this row is that link: audit it as `member.sign_in_linked`
 * in every community the account is in, queue its notice, and tell the page. Done only here, so
 * an insert that fails leaves no "linked" audit, mail or page notice. (The clean-out before it
 * did happen, and its own audit rows stay.)
 */
export async function settleTrustedLink(
  created: LinkGateAccount | null,
  ctx: LinkGateContext | null | undefined,
  deps: LinkGateDeps
): Promise<void> {
  const pending = ctx ? trustedLinks.get(ctx) : undefined;
  if (!ctx || !pending || !created) return;
  if (
    created.userId !== pending.userId ||
    created.providerId !== pending.providerId ||
    created.accountId !== pending.accountId
  )
    return;
  trustedLinks.delete(ctx);
  await transaction(deps.pool, async (client) => {
    // The issuer verified the email, and the account is now the issuer's identity's. Better Auth
    // can no longer mark an email confirmed (`user.update.before` in auth.ts strips it), so the
    // trusted link does it here, by SQL, once its row exists.
    await client.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [pending.userId]);
    const members = await client.query<{ id: string }>(
      'SELECT id FROM members WHERE user_id=$1 ORDER BY community_id,id',
      [pending.userId]
    );
    await recordSignInLinked(client, {
      userId: pending.userId,
      memberIds: members.rows.map((row) => row.id),
      changedFields: pending.cleared ? [pending.providerId, 'cleared'] : [pending.providerId],
      notice: deps.canSendNotice('account.sign_in_linked'),
      now: deps.now(),
    });
  });
  ctx.setCookie(
    LINK_NOTICE_COOKIE,
    signValue(pending.cleared ? 'linked_cleared' : 'linked', deps.config.authSecret),
    cookieOptions(deps.config, PENDING_LINK_TTL_MS)
  );
}

/** An account row Better Auth is about to create. */
export interface LinkGateAccount {
  userId: string;
  providerId: string;
  accountId: string;
}

/** What the gate needs from the server. */
export interface LinkGateDeps {
  pool: Pool;
  config: CommunityConfig;
  /** Whether mail is set up and the worker can compose this kind of notice. */
  canSendNotice: (kind: NoticeKind) => boolean;
  now: () => Date;
}

/** The attributes of the pending-link and link-notice cookies: host-only, `Path=/`. */
export function cookieOptions(
  config: Pick<CommunityConfig, 'publicUrl'>,
  maxAgeMs: number
): CookieOptions {
  return {
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https:'),
  };
}

/** Lock the account and its memberships in the order every account-wide change takes them. */
async function lockAccount(client: PoolClient, userId: string) {
  const user = await client.query<{ emailVerified: boolean }>(
    'SELECT "emailVerified" FROM "user" WHERE id=$1 FOR UPDATE',
    [userId]
  );
  const members = await client.query<{ id: string }>(
    'SELECT id FROM members WHERE user_id=$1 ORDER BY community_id,id FOR UPDATE',
    [userId]
  );
  return { user: user.rows[0] ?? null, memberIds: members.rows.map((row) => row.id) };
}

/**
 * The one gate every implicit account link passes (`databaseHooks.account.create.before`).
 *
 * With implicit linking on, Better Auth links a provider sign-in to the account with the same
 * email only when the provider vouched for that email; this gate then decides, per
 * {@link decideLink}:
 *
 * - **trusted**: refuse first if the account may not sign in at all. Then, in one transaction,
 *   lock the account and re-read whether its email was ever confirmed. Never confirmed means
 *   anyone could have made it with this email, so every way into it from before (password,
 *   sessions, other sign-in links, derived credentials) is cleared first. Once the link row exists
 *   it is audited and noticed, and the page is told what happened (`settleTrustedLink`). The clean-out commits before Better Auth inserts
 *   the link row: should that insert fail, the person is locked out of a squatted account, never
 *   the reverse.
 * - **password**: nothing is linked and no session is made. A single-use pending link is stored
 *   and the browser holds its token for 10 minutes; the callback redirects with
 *   `?error=link_needs_password`, and the page asks for the account's own password.
 *
 * Every refusal carries a `code`, so Better Auth turns it into `?error=<code>` on the sign-in
 * page rather than a JSON body.
 *
 * @param creatingUser - Whether this request created the user (see `decideLink`).
 */
export async function gateAccountLink(
  account: LinkGateAccount,
  ctx: LinkGateContext | null | undefined,
  creatingUser: boolean,
  deps: LinkGateDeps
): Promise<void> {
  const decision = decideLink({
    providerId: account.providerId,
    creatingUser,
    settingsLinkUserId:
      account.providerId === 'credential' || creatingUser ? null : await settingsLinkUserId(),
    userId: account.userId,
    trustOidc: deps.config.oidc?.linkVerifiedEmail === true,
  });
  if (decision === 'allow') return;
  // An implicit link happens only inside a provider callback, which always has a context.
  if (!ctx) throw new APIError('FORBIDDEN', { code: 'account_not_linked' });
  const refusal = await signInRefusal(deps.pool, account.userId);
  if (refusal) throw new APIError('FORBIDDEN', { code: SIGN_IN_REFUSED_CODE, message: refusal });

  if (decision === 'trusted') {
    const cleared = await transaction(deps.pool, async (client) => {
      const { user, memberIds } = await lockAccount(client, account.userId);
      if (!user) throw new APIError('FORBIDDEN', { code: 'account_not_linked' });
      // Checked again under the lock: an erasure or closure may have started meanwhile.
      const again = await signInRefusal(client, account.userId);
      if (again) throw new APIError('FORBIDDEN', { code: SIGN_IN_REFUSED_CODE, message: again });
      const unconfirmed = !user.emailVerified;
      if (unconfirmed) {
        const { xid } = await clearAccountAccess(
          client,
          account.userId,
          memberIds,
          { password: false, links: false },
          'system'
        );
        // This request's own session, made after the link, is the one the clean-out is for.
        markAccessCleared(account.userId, xid);
      }
      return unconfirmed;
    });
    // Audited, mailed and told to the page only once Better Auth has inserted the link row
    // (`settleTrustedLink`): an insert that fails must not leave anything saying "linked".
    trustedLinks.set(ctx, { ...account, cleared });
    return;
  }

  const token = randomToken();
  await deps.pool.query(
    `INSERT INTO pending_sign_in_links(token_hash,user_id,provider_id,account_id,expires_at)
     VALUES($1,$2,$3,$4,$5)`,
    [
      hashSecret(token),
      account.userId,
      account.providerId,
      account.accountId,
      new Date(deps.now().getTime() + PENDING_LINK_TTL_MS),
    ]
  );
  ctx.setCookie(
    linkCookieName(deps.config),
    signValue(token, deps.config.authSecret),
    cookieOptions(deps.config, PENDING_LINK_TTL_MS)
  );
  throw new APIError('FORBIDDEN', {
    code: LINK_NEEDS_PASSWORD_CODE,
    message: 'This email already has an account here. Enter its password to link this sign-in.',
  });
}

/**
 * Delete waiting sign-ins an hour after they expired or were used. Only their hashes and ids were
 * ever stored; the hour keeps a just-ended one around long enough to answer `410` rather than
 * look like it never existed. Returns how many went.
 */
export async function prunePendingSignInLinks(
  pool: Pick<Pool, 'query'>,
  now: Date = new Date()
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM pending_sign_in_links
     WHERE expires_at < $1::timestamptz - interval '1 hour'
        OR consumed_at < $1::timestamptz - interval '1 hour'`,
    [now]
  );
  return result.rowCount ?? 0;
}
