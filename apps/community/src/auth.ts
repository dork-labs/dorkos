import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { Pool } from 'pg';
import { COMMUNITY_PASSWORD_MIN_LENGTH } from '@dorkos/shared/community-wire';
import type { CommunityConfig } from './config.js';
import { signInRefusal } from './erasure/guards.js';
import {
  AGE_CONFIRMATION_COOKIE,
  ageConfirmationMessage,
  ageConfirmed,
} from './sign-up/minimum-age.js';
import { communityOidc, isOidcCallback, OIDC_PROVIDER_ID } from './oidc.js';
import {
  ownerReplacementAdmission,
  type OwnerReplacementAdmission,
} from './owner-replacement/admission.js';
import { hashSecret, readCookie, verifyValue } from './security.js';
import type { NoticeKind } from './mail/outbox.js';
import { gateAccountLink, settleLinkNotice, SIGN_IN_REFUSED_CODE } from './sign-in/link-gate.js';
import { sessionPredatesClearing } from './sign-in/request-start.js';

/**
 * What let a new account in: an owner grant or an invitation, or only a live claim to replace
 * a community's owner, which may name the one account it admits.
 */
type Admission = { by: 'grant' } | ({ by: 'owner_replacement' } & OwnerReplacementAdmission);

/** Create one independent Better Auth instance for a community deployment. */
export function createCommunityAuth(
  pool: Pool,
  config: CommunityConfig,
  options: {
    now?: () => Date;
    /** Whether mail is set up and the worker can compose this kind of notice. None by default. */
    canSendNotice?: (kind: NoticeKind) => boolean;
    /** Test-only: runs in `session.create.before`, after its checks, before the insert. */
    beforeSessionInsert?: (userId: string) => Promise<void>;
  } = {}
) {
  const now = options.now ?? (() => new Date());
  const canSendNotice = options.canSendNotice ?? (() => false);
  /**
   * With a minimum age set, refuse to create an account unless this browser confirmed it first
   * (`POST /api/v1/age-confirmation`). A provider callback carries the same cookie, so password,
   * Google, GitHub and single sign-on sign-ups all meet this one check.
   */
  const refuseUnconfirmedAge = (cookieHeader: string | null) => {
    if (config.minimumAge === null || ageConfirmed(cookieHeader, config, now())) return;
    // The code lets an OAuth or OIDC callback redirect with `?error=age_confirmation_required`.
    throw new APIError('FORBIDDEN', {
      code: 'age_confirmation_required',
      message: ageConfirmationMessage(config.minimumAge),
    });
  };
  const checkAdmission = async (cookieHeader: string | null): Promise<Admission | null> => {
    const grant = verifyValue(readCookie(cookieHeader, 'community_bootstrap'), config.authSecret);
    if (grant) {
      const result = await pool.query(
        `SELECT 1 FROM bootstrap_grants g
         WHERE g.token_hash=$1 AND g.consumed_at IS NULL AND g.expires_at>now()
           AND (
             (g.purpose='owner_claim' AND g.community_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM communities c
                 WHERE c.id=g.community_id AND c.lifecycle='pending_owner'
                   AND NOT EXISTS (
                     SELECT 1 FROM members m
                     WHERE m.community_id=c.id AND m.role='owner' AND m.active
                   )
               ))
           )`,
        [hashSecret(grant)]
      );
      if (result.rowCount) return { by: 'grant' };
    }
    const pending = verifyValue(readCookie(cookieHeader, 'community_admission'), config.authSecret);
    if (pending) {
      const result = await pool.query(
        `SELECT 1 FROM pending_admissions p JOIN invites i ON i.id=p.invite_id
         JOIN members m ON m.id=i.issuer_member_id
         JOIN communities c ON c.id=i.community_id
         WHERE p.token_hash=$1 AND p.expires_at>now() AND i.expires_at>now()
           AND i.revoked_at IS NULL
           AND c.lifecycle='active' AND m.active AND m.role IN ('owner','admin')`,
        [hashSecret(pending)]
      );
      if (result.rowCount) return { by: 'grant' };
    }
    // A claim to replace an owner admits a new account only while it can be claimed.
    const replacement = await ownerReplacementAdmission(
      pool,
      cookieHeader,
      config.authSecret,
      now()
    );
    return replacement ? { by: 'owner_replacement', ...replacement } : null;
  };
  /**
   * The subject each OIDC sign-up admitted only by a claim that names an account must carry,
   * by the Better Auth request it happens in. The user row is created first and its OIDC
   * account row right after, in one transaction; the account hook refuses any other subject,
   * which rolls the new user back with it.
   */
  const namedSubjects = new WeakMap<object, string>();
  /**
   * The Better Auth requests that created a user. Its account row comes next, in the same
   * transaction, and is a sign-up, not a link to an existing account. Marked in
   * `user.create.before`: the `after` hooks run only once that transaction commits, too late
   * for the account hook (and a write through the pool there would wait on the uncommitted user).
   */
  const creatingUser = new WeakSet<object>();

  return betterAuth({
    database: pool,
    secret: config.authSecret,
    baseURL: config.publicUrl,
    trustedOrigins: [config.publicUrl],
    emailAndPassword: { enabled: true, minPasswordLength: COMMUNITY_PASSWORD_MIN_LENGTH },
    // The first three hand a provider's stored access, refresh and ID tokens to any signed-in
    // session. An ID token replayed to sign-in would mint a fresh session without the provider,
    // defeating every "signed in within five minutes" rule, and nothing here needs them.
    // `/change-password` checks the current password outside the per-account guess budget every
    // other password check shares (password-confirmation.ts), so a stolen session could keep
    // guessing there; nothing here offers a password change, so it is off. `/delete-user` stays
    // off by Better Auth's own default and answers 404 before it looks at any password.
    disabledPaths: ['/get-access-token', '/refresh-token', '/account-info', '/change-password'],
    socialProviders: {
      // Sign-in only through the provider's own redirect, never a bare ID token (see hooks).
      ...(config.oauth.google
        ? { google: { ...config.oauth.google, disableIdTokenSignIn: true } }
        : {}),
      ...(config.oauth.github ? { github: config.oauth.github } : {}),
    },
    // A provider sign-in whose email matches an existing account may link to it, but only an
    // identity whose email the provider verified (no provider is trusted by name), and only
    // through the one gate in `databaseHooks.account.create.before` (sign-in/link-gate.ts): the
    // host's trusted OIDC issuer links at once, every other provider needs the account's
    // password first. The local email's state is the gate's to judge, not a blanket refusal.
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        requireLocalEmailVerified: false,
        trustedProviders: [],
        allowDifferentEmails: false,
      },
    },
    // The host's optional OpenID Connect sign-in. Unset, nothing is registered or fetched.
    plugins: config.oidc ? [communityOidc(config.oidc, { now: options.now })] : [],
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: {
      useSecureCookies: config.publicUrl.startsWith('https:'),
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.publicUrl.startsWith('https:'),
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // A bare ID token proves only that someone once held one, not that the person is at
        // the keyboard now. Every provider signs in and links through its redirect instead.
        if (
          (ctx.path === '/sign-in/social' || ctx.path === '/link-social') &&
          (ctx.body as { idToken?: unknown } | undefined)?.idToken !== undefined
        ) {
          throw new APIError('BAD_REQUEST', {
            code: 'id_token_sign_in_disabled',
            message: 'Sign in through your sign-in service instead.',
          });
        }
        if (ctx.path.startsWith('/sign-up/')) {
          const admission = await checkAdmission(ctx.headers?.get('cookie') ?? null);
          if (!admission) {
            throw new APIError('FORBIDDEN', {
              message: 'An invitation or owner grant is required.',
            });
          }
          // A claim that names an account admits only that account, made through the host's
          // sign-in service, never a password sign-up.
          if (admission.by === 'owner_replacement' && admission.claimant) {
            throw new APIError('FORBIDDEN', {
              code: 'single_sign_on_required',
              message: 'Create your account through the sign-in service named in the request.',
            });
          }
          refuseUnconfirmedAge(ctx.headers?.get('cookie') ?? null);
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            const admission = await checkAdmission(ctx?.headers?.get('cookie') ?? null);
            if (!admission) {
              // The code lets an OAuth or OIDC callback redirect with `?error=invitation_required`.
              throw new APIError('FORBIDDEN', {
                code: 'invitation_required',
                message: 'An invitation or owner grant is required.',
              });
            }
            if (admission.by === 'owner_replacement' && admission.claimant) {
              // Only a sign-up through the issuer the request named, which the host still uses.
              if (!ctx || !isOidcCallback(ctx) || config.oidc?.issuer !== admission.claimant.issuer)
                throw new APIError('FORBIDDEN', {
                  code: 'single_sign_on_required',
                  message: 'Create your account through the sign-in service named in the request.',
                });
              namedSubjects.set(ctx, admission.claimant.subject);
            }
            refuseUnconfirmedAge(ctx?.headers?.get('cookie') ?? null);
            if (ctx) creatingUser.add(ctx);
            return { data: user };
          },
          // One confirmation makes one account: clear it, so the next person to sign up in this
          // browser is asked again rather than riding on someone else's tick.
          after: async (_user, ctx) => {
            if (config.minimumAge === null || !ctx) return;
            ctx.setCookie(AGE_CONFIRMATION_COOKIE, '', {
              path: '/',
              maxAge: 0,
              httpOnly: true,
              sameSite: 'lax',
              secure: config.publicUrl.startsWith('https:'),
            });
          },
        },
      },
      account: {
        create: {
          before: async (account, ctx) => {
            // The account row of a sign-up a named claim admitted must be the named identity.
            const subject = ctx ? namedSubjects.get(ctx) : undefined;
            if (
              subject !== undefined &&
              (account.providerId !== OIDC_PROVIDER_ID || account.accountId !== subject)
            )
              throw new APIError('FORBIDDEN', {
                code: 'claim_account_mismatch',
                message: 'Sign in with the account named in the request, then try again.',
              });
            // Every implicit link to an existing account passes this one gate.
            await gateAccountLink(account, ctx, ctx ? creatingUser.has(ctx) : false, {
              pool,
              config,
              canSendNotice,
              now,
            });
            return { data: account };
          },
          // A trusted link tells the page only once its row exists.
          after: async (account, ctx) => {
            settleLinkNotice(account, ctx, config);
          },
        },
      },
      session: {
        create: {
          // Every sign-in method ends here, including an OAuth callback whose account a
          // request hook cannot see, so a running account erasure, or a host's closure of the
          // account, refuses them all at once.
          before: async (session) => {
            const refusal = await signInRefusal(pool, session.userId);
            // The code lands a refused provider callback on the sign-in page, not a JSON body.
            if (refusal)
              throw new APIError('FORBIDDEN', { code: SIGN_IN_REFUSED_CODE, message: refusal });
            // Early answer for a request that began before the account was cleared. The `after`
            // check below is the one that holds under a race.
            if (await sessionPredatesClearing(pool, session.userId, { lock: false }))
              throw clearedRefusal();
            await options.beforeSessionInsert?.(session.userId);
            return { data: session };
          },
          /**
           * A sign-in reads the password or link it trusts, then makes the session, with no lock
           * between. A clean-out (`clearAccountAccess`) that commits in between must not leave
           * that session standing. This runs once the session row is committed:
           *
           * - Session committed before the clean-out deletes sessions: the clean-out's
           *   `DELETE FROM session` removes it. (Inserting a session takes a key-share lock on the
           *   account row, which waits while a clean-out holds it `FOR UPDATE`, so an insert
           *   cannot slip in after that DELETE and before the commit.)
           * - Session committed after the clean-out: `FOR SHARE` waits for a clean-out still
           *   holding the row, then reads its stamp. If the request's start snapshot cannot see
           *   the clean-out's transaction, the request may have authenticated with something it
           *   removed: the session is deleted and the sign-in refused.
           *
           * The request that did the clean-out is exempt: its session is the new owner's.
           */
          after: async (session) => {
            if (!(await sessionPredatesClearing(pool, session.userId, { lock: true }))) return;
            await pool.query('DELETE FROM session WHERE id=$1', [session.id]);
            throw clearedRefusal();
          },
        },
      },
    },
  });
}

/** The refusal a sign-in gets when the account was cleared while it was under way. */
function clearedRefusal() {
  return new APIError('FORBIDDEN', {
    code: SIGN_IN_REFUSED_CODE,
    message: 'This account changed while you were signing in. Sign in again.',
  });
}

/** Better Auth instance type shared with the request guard. */
export type CommunityAuth = ReturnType<typeof createCommunityAuth>;
