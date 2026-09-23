import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { Pool } from 'pg';
import type { CommunityConfig } from './config.js';
import { accountErasureRunning } from './erasure-guards.js';
import { hashSecret, readCookie, verifyValue } from './security.js';

/** Create one independent Better Auth instance for a community deployment. */
export function createCommunityAuth(pool: Pool, config: CommunityConfig) {
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
    emailAndPassword: { enabled: true },
    socialProviders: {
      ...(config.oauth.google ? { google: config.oauth.google } : {}),
      ...(config.oauth.github ? { github: config.oauth.github } : {}),
    },
    account: { accountLinking: { disableImplicitLinking: true } },
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
              throw new APIError('FORBIDDEN', {
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
