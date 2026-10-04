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

/** The cookie that carries a sign-in waiting for the matched account's password. */
export const PENDING_LINK_COOKIE = 'community_pending_link';
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

function cookieOptions(config: CommunityConfig, maxAgeMs: number): CookieOptions {
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
 *   sessions, other sign-in links, derived credentials) is cleared first. The link is audited and
 *   noticed, and the page is told what happened. The clean-out commits before Better Auth inserts
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
      if (unconfirmed)
        await clearAccountAccess(
          client,
          account.userId,
          memberIds,
          { password: false, links: false },
          'system'
        );
      await recordSignInLinked(client, {
        userId: account.userId,
        memberIds,
        changedFields: unconfirmed ? [account.providerId, 'cleared'] : [account.providerId],
        notice: deps.canSendNotice('account.sign_in_linked'),
        now: deps.now(),
      });
      return unconfirmed;
    });
    ctx.setCookie(
      LINK_NOTICE_COOKIE,
      signValue(cleared ? 'linked_cleared' : 'linked', deps.config.authSecret),
      cookieOptions(deps.config, PENDING_LINK_TTL_MS)
    );
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
    PENDING_LINK_COOKIE,
    signValue(token, deps.config.authSecret),
    cookieOptions(deps.config, PENDING_LINK_TTL_MS)
  );
  throw new APIError('FORBIDDEN', {
    code: LINK_NEEDS_PASSWORD_CODE,
    message: 'This email already has an account here. Enter its password to link this sign-in.',
  });
}
