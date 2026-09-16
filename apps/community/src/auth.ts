import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { Pool } from 'pg';
import type { CommunityConfig } from './config.js';
import { hashSecret, readCookie, verifyValue } from './security.js';

/** Create one independent Better Auth instance for a community deployment. */
export function createCommunityAuth(pool: Pool, config: CommunityConfig) {
  const checkAdmission = async (cookieHeader: string | null) => {
    const grant = verifyValue(readCookie(cookieHeader, 'community_bootstrap'), config.authSecret);
    if (grant) {
      const result = await pool.query(
        `SELECT 1 FROM bootstrap_grants WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()
         AND NOT EXISTS (SELECT 1 FROM members WHERE role='owner' AND active)`,
        [hashSecret(grant)]
      );
      if (result.rowCount) return true;
    }
    const pending = verifyValue(readCookie(cookieHeader, 'community_admission'), config.authSecret);
    if (pending) {
      const result = await pool.query(
        'SELECT 1 FROM pending_admissions WHERE token_hash=$1 AND expires_at>now()',
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
    },
  });
}

/** Better Auth instance type shared with the request guard. */
export type CommunityAuth = ReturnType<typeof createCommunityAuth>;
