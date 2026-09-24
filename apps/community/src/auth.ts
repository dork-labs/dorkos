import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { Pool } from 'pg';
import { COMMUNITY_PASSWORD_MIN_LENGTH } from '@dorkos/shared/community-wire';
import type { CommunityConfig } from './config.js';
import { accountErasureRunning } from './erasure/guards.js';
import { communityOidc } from './oidc.js';
import { hashSecret, readCookie, verifyValue } from './security.js';

/** Create one independent Better Auth instance for a community deployment. */
export function createCommunityAuth(
  pool: Pool,
  config: CommunityConfig,
  options: { now?: () => Date } = {}
) {
  const checkAdmission = async (cookieHeader: string | null) => {
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
      if (result.rowCount) return true;
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
      if (result.rowCount) return true;
    }
    return false;
  };

  return betterAuth({
    database: pool,
    secret: config.authSecret,
    baseURL: config.publicUrl,
    trustedOrigins: [config.publicUrl],
    emailAndPassword: { enabled: true, minPasswordLength: COMMUNITY_PASSWORD_MIN_LENGTH },
    // These three hand a provider's stored access, refresh and ID tokens to any signed-in
    // session. An ID token replayed to sign-in would mint a fresh session without the provider,
    // defeating every "signed in within five minutes" rule, and nothing here needs them.
    disabledPaths: ['/get-access-token', '/refresh-token', '/account-info'],
    socialProviders: {
      // Sign-in only through the provider's own redirect, never a bare ID token (see hooks).
      ...(config.oauth.google
        ? { google: { ...config.oauth.google, disableIdTokenSignIn: true } }
        : {}),
      ...(config.oauth.github ? { github: config.oauth.github } : {}),
    },
    // An OIDC or social identity whose email matches an existing account is refused, never
    // silently attached; a person links one from their account page after signing in.
    account: { accountLinking: { disableImplicitLinking: true } },
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
            message: 'Sign in through the provider instead.',
          });
        }
        if (ctx.path.startsWith('/sign-up/')) {
          if (!(await checkAdmission(ctx.headers?.get('cookie') ?? null))) {
            throw new APIError('FORBIDDEN', {
              message: 'An invitation or owner grant is required.',
            });
          }
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (!(await checkAdmission(ctx?.headers?.get('cookie') ?? null))) {
              // The code lets an OAuth or OIDC callback redirect with `?error=invitation_required`.
              throw new APIError('FORBIDDEN', {
                code: 'invitation_required',
                message: 'An invitation or owner grant is required.',
              });
            }
            return { data: user };
          },
        },
      },
      session: {
        create: {
          // Every sign-in method ends here, including an OAuth callback whose account a
          // request hook cannot see, so a running account erasure refuses them all at once.
          before: async (session) => {
            if (await accountErasureRunning(pool, session.userId)) {
              throw new APIError('FORBIDDEN', {
                message: 'This account is being deleted.',
              });
            }
            return { data: session };
          },
        },
      },
    },
  });
}

/** Better Auth instance type shared with the request guard. */
export type CommunityAuth = ReturnType<typeof createCommunityAuth>;
