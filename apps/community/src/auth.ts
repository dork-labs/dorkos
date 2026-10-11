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
import { gateAccountLink, settleTrustedLink, SIGN_IN_REFUSED_CODE } from './sign-in/link-gate.js';
import { withRequestStart, writtenBeforeClearing } from './sign-in/request-start.js';
import { communityEmailLinks } from './email-links/plugin.js';
import { queueEmailConfirmation } from './email-links/requests.js';
import { notifyLive } from './live/notices.js';
import { isBanned } from './moderation/bans.js';
import {
  OPEN_ADMISSION_COOKIE,
  openAdmissionAvailable,
  readOpenAdmission,
} from './admission/open-admission-cookie.js';

/**
 * What let a new account in: an owner grant or an invitation (with the community it admits to,
 * for an invitation), a live claim to replace a community's owner, which may name the one
 * account it admits, or a space open to anyone who signs in through the host's single sign-on.
 */
export type Admission =
  | { by: 'grant'; communityId?: string }
  | ({ by: 'owner_replacement' } & OwnerReplacementAdmission)
  | { by: 'open'; communityId: string };

/** The refusal a sign-up for a space that banned its email gets; the code names no ban. */
function admissionRefused() {
  return new APIError('FORBIDDEN', {
    code: 'admission_refused',
    message: "You can't join this space.",
  });
}

/** Create one independent Better Auth instance for a community deployment. */
export function createCommunityAuth(
  pool: Pool,
  config: CommunityConfig,
  options: {
    now?: () => Date;
    /** Whether mail is set up and the worker can compose this kind of notice. None by default. */
    canSendNotice?: (kind: NoticeKind) => boolean;
    /**
     * Whether this server mails reset, sign-in and confirmation links (mail on, and the worker can
     * compose all three). Off by default: the link endpoints answer `409` and sign-up queues no
     * confirmation.
     */
    emailLinksOn?: boolean;
    /** Test-only: runs in `session.create.before`, after its checks, before the insert. */
    beforeSessionInsert?: (userId: string) => Promise<void>;
  } = {}
) {
  const now = options.now ?? (() => new Date());
  const canSendNotice = options.canSendNotice ?? (() => false);
  const emailLinksOn = options.emailLinksOn ?? false;
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
      const result = await pool.query<{ community_id: string }>(
        `SELECT i.community_id FROM pending_admissions p JOIN invites i ON i.id=p.invite_id
         JOIN members m ON m.id=i.issuer_member_id
         JOIN communities c ON c.id=i.community_id
         WHERE p.token_hash=$1 AND p.expires_at>now() AND i.expires_at>now()
           AND i.revoked_at IS NULL
           AND c.lifecycle='active' AND m.active AND m.role IN ('owner','admin')`,
        [hashSecret(pending)]
      );
      if (result.rows[0]) return { by: 'grant', communityId: result.rows[0].community_id };
    }
    // A claim to replace an owner admits a new account only while it can be claimed.
    const replacement = await ownerReplacementAdmission(
      pool,
      cookieHeader,
      config.authSecret,
      now()
    );
    if (replacement) return { by: 'owner_replacement', ...replacement };
    // Last, and weakest: this browser asked to join a space open to single sign-on.
    const open = readOpenAdmission(cookieHeader, config, now().getTime());
    if (open && openAdmissionAvailable(config)) {
      const result = await pool.query(
        "SELECT 1 FROM communities WHERE id=$1 AND admission_policy='open' AND lifecycle='active'",
        [open]
      );
      if (result.rowCount) return { by: 'open', communityId: open };
    }
    return null;
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

  const auth = betterAuth({
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
    // Better Auth's own reset, email verification and email change are off too: mailed links are
    // this server's own (email-links/plugin.ts), because the built-ins store tokens in plain text,
    // act on a GET, can create accounts, and end no derived credentials (ADR 261005-102035).
    // `/verify-password` checks a password over HTTP outside the shared guess budget; the server
    // keeps calling it through `auth.api`, which `disabledPaths` does not touch. These match exact
    // paths only, so `/reset-password/:token` is refused in app.ts before this handler.
    disabledPaths: [
      '/get-access-token',
      '/refresh-token',
      '/account-info',
      '/change-password',
      '/request-password-reset',
      '/reset-password',
      '/send-verification-email',
      '/verify-email',
      '/change-email',
      '/verify-password',
    ],
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
    // The host's optional OpenID Connect sign-in (unset, nothing is registered or fetched), and
    // the mailed reset and sign-in links, always registered and off without mail.
    plugins: [
      ...(config.oidc ? [communityOidc(config.oidc, { now: options.now })] : []),
      communityEmailLinks({ pool, config, on: emailLinksOn, canSendNotice }),
    ],
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
          // sign-in service, never a password sign-up. An open space is the same: it never
          // turns this gate into public password sign-up.
          const passwordRefusal = openPasswordSignUpRefusal(admission);
          if (passwordRefusal) throw passwordRefusal;
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
            // A Google, GitHub or single sign-on sign-up must come with an email its provider
            // verified. Otherwise anyone could make an account here, with a sign-in that outlives
            // every reset, using an address that isn't theirs. (Linking an identity to an
            // existing account already needs a verified email; this closes the sign-up.)
            if (isProviderCallback(ctx) && user.emailVerified !== true)
              throw new APIError('FORBIDDEN', {
                code: 'email_not_verified',
                message: "Your sign-in service hasn't confirmed this email.",
              });
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
            const creationRefusal = openAccountCreationRefusal(admission, ctx);
            if (creationRefusal) throw creationRefusal;
            // A space that banned this email refuses a new account made to join it, when a
            // provider vouched for the email. A password sign-up's email is only typed: it is
            // checked by account at redeem, and by email once confirmed.
            if (
              (admission.by === 'open' || admission.by === 'grant') &&
              admission.communityId &&
              isProviderCallback(ctx) &&
              user.emailVerified === true &&
              (await isBanned(
                pool,
                admission.communityId,
                { email: user.email },
                config.authSecret
              ))
            )
              throw admissionRefused();
            refuseUnconfirmedAge(ctx?.headers?.get('cookie') ?? null);
            if (ctx) creatingUser.add(ctx);
            return { data: user };
          },
          // A new account whose email nobody has proven yet (a password sign-up) is mailed a
          // confirmation link. A provider sign-up the issuer vouched for is already confirmed.
          // One age confirmation makes one account: clear it, so the next person to sign up in
          // this browser is asked again rather than riding on someone else's tick.
          after: async (user, ctx) => {
            if (emailLinksOn && !user.emailVerified)
              await queueEmailConfirmation(pool, {
                userId: user.id,
                email: user.email,
                authSecret: config.authSecret,
              });
            // One open-admission click makes at most one account, like the age confirmation.
            if (ctx && readOpenAdmission(ctx.headers?.get('cookie') ?? null, config))
              ctx.setCookie(OPEN_ADMISSION_COOKIE, '', {
                path: '/',
                maxAge: 0,
                httpOnly: true,
                sameSite: 'lax',
                secure: config.publicUrl.startsWith('https:'),
              });
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
        update: {
          /**
           * Only this server's own SQL marks an existing account's email confirmed: a mailed
           * reset, sign-in or confirmation link (each clearing a never-confirmed account first),
           * or a trusted single sign-on link (`settleTrustedLink`). Better Auth would otherwise
           * mark it on any sign-in with an already-linked provider whose email is verified, with
           * no clean-out, which would confirm a squatted account for its squatter. So the field
           * is removed from every update Better Auth makes. (A provider sign-up still creates its
           * user with the issuer's verified flag: that is a create, not an update.)
           */
          before: async (user) => {
            delete (user as { emailVerified?: unknown }).emailVerified;
            return { data: user };
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
          /**
           * A request that checked the account before a clean-out (`clearAccountAccess`)
           * committed must not leave a new way in behind it: `setPassword` checks there is no
           * password, hashes, then inserts; `/link-social` checks, then inserts. Runs once the
           * row is committed:
           *
           * - Row committed before the clean-out's `DELETE FROM account`: that DELETE removes it.
           *   (Its foreign-key check takes a key-share lock on the user row, which waits while a
           *   clean-out holds it `FOR UPDATE`, so it cannot land between that DELETE and the
           *   commit.)
           * - Row committed after: the `FOR SHARE` read waits for the clean-out, then sees its
           *   stamp. The request's start snapshot cannot see that clean-out, so the row is
           *   deleted and the request refused.
           *
           * The clean-out's own request is exempt: its link row is the new owner's. A trusted
           * link is audited, mailed and shown only once its row exists and has passed this.
           */
          after: async (account, ctx) => {
            if (await writtenBeforeClearing(pool, account.userId, { lock: true })) {
              await pool.query('DELETE FROM account WHERE id=$1', [account.id]);
              throw clearedRefusal();
            }
            await settleTrustedLink(account, ctx, { pool, config, canSendNotice, now });
          },
        },
        update: {
          /**
           * The same rule for an update. Better Auth's `update.before` sees only the changed
           * fields, not whose row it is, so the check runs here, after the commit. Better Auth's
           * own password change and reset are off, and a mailed reset or confirmation writes the
           * password row in this server's own transaction, never through Better Auth, so updates
           * here only refresh a provider link's tokens: a stale one adds no way in; the sign-in it
           * belongs to is refused, and its session too (`session.create.after`). A stale update
           * to a password row would be one a clean-out did not write, so that row is deleted: the
           * account then has no password, which fails closed.
           */
          after: async (account) => {
            if (!account || !(await writtenBeforeClearing(pool, account.userId, { lock: true })))
              return;
            if (account.providerId === 'credential')
              await pool.query('DELETE FROM account WHERE id=$1', [account.id]);
            throw clearedRefusal();
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
            if (await writtenBeforeClearing(pool, session.userId, { lock: false }))
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
           *   `"user"` row for its foreign key; `clearAccountAccess` holds that row `FOR UPDATE`,
           *   so an insert cannot slip in after that DELETE and before the commit.)
           * - Session committed after the clean-out: `FOR SHARE` waits for a clean-out still
           *   holding the row, then reads its stamp. If the request's start snapshot cannot see
           *   the clean-out's transaction, the request may have authenticated with something it
           *   removed: the session is deleted and the sign-in refused.
           *
           * The request that did the clean-out is exempt: its session is the new owner's.
           */
          after: async (session) => {
            if (!(await writtenBeforeClearing(pool, session.userId, { lock: true }))) return;
            await pool.query('DELETE FROM session WHERE id=$1', [session.id]);
            await notifyLive(pool, { k: 'user', u: session.userId });
            throw clearedRefusal();
          },
        },
        /**
         * Sign-out, revoking one session or all of them, and clearing an expired one: Better Auth
         * deletes the row itself and calls this after its commit. A live stream opened with that
         * session rechecks at once rather than at its fallback re-read.
         */
        delete: {
          after: async (session) => {
            await notifyLive(pool, { k: 'user', u: session.userId });
          },
        },
      },
    },
  });
  // Every Better Auth request but reading a session records its start (sign-in/request-start.ts),
  // so the hooks above can tell a write that began before a clean-out from one after it.
  const handler = auth.handler;
  auth.handler = (request: Request) =>
    request.method === 'GET' && new URL(request.url).pathname.endsWith('/get-session')
      ? handler(request)
      : withRequestStart(pool, () => handler(request));
  return auth;
}

/**
 * The first of an open space's two password gates, at the sign-up endpoints: a browser that
 * asked to join an open space may not sign up with a password. `null` lets the sign-up go on.
 */
export function openPasswordSignUpRefusal(admission: Admission): APIError | null {
  if (admission.by !== 'open') return null;
  return new APIError('FORBIDDEN', {
    code: 'single_sign_on_required',
    message: 'Join this space through its single sign-on.',
  });
}

/**
 * The second, where every account is created: an open space admits a new account only on the
 * host's single sign-on callback, whose email the issuer verified (checked for every provider
 * callback). It holds even for a path the first gate never sees. `null` lets the creation go on.
 */
export function openAccountCreationRefusal(
  admission: Admission,
  ctx: { path?: string; params?: unknown } | null | undefined
): APIError | null {
  if (admission.by !== 'open' || (ctx && isOidcCallback(ctx))) return null;
  return new APIError('FORBIDDEN', {
    code: 'single_sign_on_required',
    message: 'Join this space through its single sign-on.',
  });
}

/** Whether this Better Auth request is a provider's redirect back (Google, GitHub, single sign-on). */
function isProviderCallback(ctx: { path?: string } | null | undefined): boolean {
  return (
    ctx?.path?.startsWith('/callback/') === true ||
    ctx?.path?.startsWith('/oauth2/callback/') === true
  );
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
