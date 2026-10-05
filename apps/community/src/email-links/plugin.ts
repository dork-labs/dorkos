import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { hashPassword } from 'better-auth/crypto';
import type { Pool } from 'pg';
import {
  CommunityWireEmailLinkTokenRequestSchema,
  CommunityWireEmailSignInResponseSchema,
  CommunityWirePasswordResetUseRequestSchema,
  CommunityWirePasswordResetUseResponseSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import type { NoticeKind } from '../mail/outbox.js';
import { hashSecret } from '../security.js';
import { clearAccountAccess } from '../sign-in/account-access.js';
import { cookieOptions, linkCookieName } from '../sign-in/link-gate.js';
import { recordSignInLinked, signInName } from '../sign-in/linked.js';
import { markAccessCleared } from '../sign-in/request-start.js';
import { pendingTokenHash } from '../routes/account/sign-in-link.js';
import type { EmailLinkKind } from './model.js';
import {
  auditAccount,
  checkLink,
  consumeLink,
  lockLinkAccount,
  writePassword,
  type LinkCheck,
} from './tokens.js';

/** What the plugin needs from the server. */
export interface EmailLinkPluginDeps {
  pool: Pool;
  config: CommunityConfig;
  /** Whether this server mails links; off, both uses answer `409`. */
  on: boolean;
  /** Whether mail is set up and the worker can compose this kind of notice. */
  canSendNotice: (kind: NoticeKind) => boolean;
}

/** The Better Auth endpoint context, as its own cookie helpers take it. */
type EndpointContext = Parameters<typeof setSessionCookie>[0];

/** The plugin's id, which the route census and auth.ts name. */
export const EMAIL_LINKS_PLUGIN_ID = 'community-email-links';

const EXPIRED = 'This link expired or was already used. Ask for a new one.';
const ELSEWHERE =
  'This link expired, was used, or was opened elsewhere. Open it in the browser where you asked.';

function gone(message = EXPIRED) {
  return new APIError('GONE', { code: 'LINK_EXPIRED', message });
}

function alreadyLinked() {
  return new APIError('CONFLICT', {
    code: 'ALREADY_LINKED',
    message: 'That sign-in is already linked to another account here. Nothing was changed.',
  });
}

function refused(message: string) {
  return new APIError('FORBIDDEN', { code: 'SIGN_IN_REFUSED', message });
}

/**
 * Turn a check that did not pass into its refusal. A stale link was already marked replaced in
 * the committed transaction; an `elsewhere` or `refused` one is untouched.
 */
function refusalFor(check: Exclude<LinkCheck, { state: 'ok' }>): APIError {
  if (check.state === 'refused') return refused(check.message);
  return gone(check.state === 'elsewhere' ? ELSEWHERE : EXPIRED);
}

/**
 * Use one link in a single transaction: lock the account and its memberships, then the token,
 * run every check, and only then `apply`. A check that marks the token dead commits that write
 * and refuses after.
 */
async function useLink<T>(
  deps: EmailLinkPluginDeps,
  input: { token: string; kind: EmailLinkKind; pendingHash: string | null },
  apply: (
    client: import('pg').PoolClient,
    link: Extract<LinkCheck, { state: 'ok' }>,
    memberIds: string[]
  ) => Promise<T>
): Promise<T> {
  const tokenHash = hashSecret(input.token);
  const outcome = await transaction(deps.pool, async (client) => {
    const locked = await lockLinkAccount(client, tokenHash);
    if (!locked) return { refusal: gone() };
    const check = await checkLink(client, {
      tokenHash,
      kind: input.kind,
      config: deps.config,
      pendingHash: input.pendingHash,
      lock: true,
    });
    // A refused account must change nothing: roll back by throwing.
    if (check.state === 'refused') throw refusalFor(check);
    if (check.state !== 'ok') return { refusal: refusalFor(check) };
    return { value: await apply(client, check, locked.memberIds) };
  });
  if ('refusal' in outcome) throw outcome.refusal;
  return outcome.value;
}

/**
 * Sign this browser in as `userId` the way any sign-in does: Better Auth makes the session, so
 * every session hook runs (a refused or erased account, a clean-out that overtook this request),
 * and sets the same cookie a password sign-in sets. A refusal here comes after the link was used
 * and its changes committed; the person is told to sign in again.
 */
async function signInAs(ctx: EndpointContext, userId: string): Promise<void> {
  let session: Awaited<ReturnType<EndpointContext['context']['internalAdapter']['createSession']>>;
  try {
    session = await ctx.context.internalAdapter.createSession(userId);
  } catch (cause) {
    const message = (cause as { body?: { message?: string } }).body?.message;
    throw refused(message ?? 'This account changed while you were signing in. Sign in again.');
  }
  const user = await ctx.context.internalAdapter.findUserById(userId);
  if (!session || !user) throw refused('This account changed. Sign in again.');
  await setSessionCookie(ctx, { session, user });
}

/**
 * Better Auth endpoints that use a mailed reset or sign-in link. Both are POST only: the page
 * reads the token from the link's `#` fragment and posts it, so a mail scanner's GET of the link
 * does nothing. Each runs every check under the account's lock, uses the token once, and signs
 * the browser in through Better Auth's own session path.
 *
 * - `POST /email-link/reset-password` sets a new password and ends every other way in that came
 *   from before (see `clearAccountAccess`): on a confirmed account sessions, connections, agent
 *   credentials, pairings, invitation links and server API keys end and provider sign-ins stay;
 *   on a never-confirmed account those go too, because the link is the first proof of the
 *   mailbox, and the email is then marked confirmed.
 * - `POST /email-link/sign-in` works only in the browser that holds the held sign-in its request
 *   named. On a never-confirmed account it first clears everything (password and provider
 *   links included) and marks the email confirmed. It then links the held sign-in.
 *
 * Neither ever creates an account: a link exists only for an existing one.
 */
export function communityEmailLinks(deps: EmailLinkPluginDeps): BetterAuthPlugin {
  const unavailable = () =>
    new APIError('CONFLICT', {
      code: 'NOTICE_DELIVERY_UNAVAILABLE',
      message: "This space can't send email. Ask the person running it for help.",
    });
  return {
    id: EMAIL_LINKS_PLUGIN_ID,
    endpoints: {
      emailLinkResetPassword: createAuthEndpoint(
        '/email-link/reset-password',
        { method: 'POST', body: CommunityWirePasswordResetUseRequestSchema },
        async (ctx) => {
          if (!deps.on) throw unavailable();
          // Hashed before any lock is taken: the hasher is deliberately slow.
          const hash = await hashPassword(ctx.body.newPassword);
          const result = await useLink(
            deps,
            { token: ctx.body.token, kind: 'password_reset', pendingHash: null },
            async (client, link, memberIds) => {
              const confirmed = link.account.emailVerified;
              // Used up first and explicitly, as every other use does; the clean-out below then
              // deletes it with the account's other links.
              await consumeLink(client, hashSecret(ctx.body.token));
              await writePassword(client, link.account.id, hash);
              const { xid } = await clearAccountAccess(
                client,
                link.account.id,
                memberIds,
                { password: true, links: confirmed },
                'system'
              );
              if (!confirmed)
                await client.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [
                  link.account.id,
                ]);
              await auditAccount(
                client,
                memberIds,
                'member.password_reset',
                confirmed ? ['password'] : ['password', 'cleared']
              );
              if (!confirmed)
                await auditAccount(client, memberIds, 'member.email_confirmed', ['reset']);
              return { userId: link.account.id, xid, confirmed };
            }
          );
          // This request's own session is the one the clean-out is for, while it stays the
          // account's latest clean-out.
          markAccessCleared(result.userId, result.xid);
          await signInAs(ctx, result.userId);
          return ctx.json(
            CommunityWirePasswordResetUseResponseSchema.parse({
              cleared: result.confirmed ? 'access' : 'everything',
            })
          );
        }
      ),
      emailLinkSignIn: createAuthEndpoint(
        '/email-link/sign-in',
        { method: 'POST', body: CommunityWireEmailLinkTokenRequestSchema },
        async (ctx) => {
          if (!deps.on) throw unavailable();
          const pendingHash = pendingTokenHash(ctx.headers?.get('cookie') ?? null, deps.config);
          const result = await useLink(
            deps,
            { token: ctx.body.token, kind: 'sign_in', pendingHash },
            async (client, link, memberIds) => {
              const userId = link.account.id;
              const hold = link.hold!;
              // Checked before anything changes: a held identity some other account has linked
              // since can never join this one, and clearing first would leave it with no way in.
              const taken = await client.query(
                `SELECT 1 FROM account WHERE "providerId"=$1 AND "accountId"=$2`,
                [hold.providerId, hold.accountId]
              );
              if (taken.rowCount) throw alreadyLinked();
              await client.query(
                'UPDATE pending_sign_in_links SET consumed_at=now() WHERE token_hash=$1',
                [hold.pendingHash]
              );
              await consumeLink(client, hashSecret(ctx.body.token));
              const cleared = !link.account.emailVerified;
              let xid: string | null = null;
              if (cleared) {
                ({ xid } = await clearAccountAccess(
                  client,
                  userId,
                  memberIds,
                  { password: false, links: false },
                  'system'
                ));
                await client.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [userId]);
                await auditAccount(client, memberIds, 'member.email_confirmed', ['sign_in']);
              }
              // The held identity joins the account. Another account linked it meanwhile: refuse,
              // and the whole transaction (the clean-out with it) rolls back.
              try {
                await client.query(
                  `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,$2,$3,$4)`,
                  [randomUUID(), hold.accountId, hold.providerId, userId]
                );
              } catch (cause) {
                if ((cause as { code?: string }).code === '23505') throw alreadyLinked();
                throw cause;
              }
              await recordSignInLinked(client, {
                userId,
                memberIds,
                changedFields: cleared
                  ? [hold.providerId, 'email', 'cleared']
                  : [hold.providerId, 'email'],
                notice: deps.canSendNotice('account.sign_in_linked'),
                now: new Date(),
              });
              return { userId, xid, cleared, provider: hold.providerId };
            }
          );
          if (result.xid) markAccessCleared(result.userId, result.xid);
          await signInAs(ctx, result.userId);
          ctx.setCookie(linkCookieName(deps.config), '', cookieOptions(deps.config, 0));
          return ctx.json(
            CommunityWireEmailSignInResponseSchema.parse({
              cleared: result.cleared,
              linked: result.provider ? signInName(result.provider, deps.config) : null,
            })
          );
        }
      ),
    },
  };
}
