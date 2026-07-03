/**
 * Better Auth — the local identity core for the DorkOS server (accounts-and-auth P1).
 *
 * Wraps a single {@link https://better-auth.com | Better Auth} instance over the
 * consolidated `@dorkos/db` SQLite database (tables in `packages/db/src/schema/auth.ts`).
 * It provides email + password local accounts (email is an identifier only —
 * never verified, no SMTP) and per-user scoped API keys via the `apiKey` plugin.
 *
 * ## Registration policy
 *
 * Sign-up is open only while the `user` table is empty; the first registered
 * user becomes the `owner`. Once any user exists every further sign-up is
 * rejected (a `databaseHooks.user.create.before` hook that throws
 * `FORBIDDEN`). A future invites spec reopens registration via invitation
 * tokens only.
 *
 * ## Lifecycle
 *
 * {@link initAuth} is called once at startup (`index.ts`) with the server's
 * Drizzle db; `app.ts` mounts {@link getAuth} at `/api/auth/*` before
 * `express.json()`. The handler is always mounted regardless of
 * `config.auth.enabled` so the enable-login flow can create the owner account
 * before the flag flips. The `auth.enabled` gate (task 1.2) does not live here.
 *
 * ## Secret management
 *
 * Session cookies are signed by Better Auth's own secret management, which reads
 * `BETTER_AUTH_SECRET` (or `AUTH_SECRET`) from the environment. Production
 * deployments should set `BETTER_AUTH_SECRET` so sessions survive restarts;
 * without it Better Auth falls back to a development secret.
 *
 * @module services/core/auth
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { apiKey } from '@better-auth/api-key';
import { user, session, account, verification, apikey, type Db } from '@dorkos/db';
import { env } from '../../../env.js';
import { resolveTrustedOrigins } from '../../../lib/trusted-origins.js';

/** The configured Better Auth instance type (return of {@link createAuth}). */
export type Auth = ReturnType<typeof createAuth>;

const isProduction = env.NODE_ENV === 'production';

/**
 * Build a Better Auth instance bound to the given Drizzle SQLite database.
 *
 * Exported (rather than only the singleton) so integration tests can construct
 * an instance over a throwaway temp database without booting the whole server.
 *
 * @param db - The server's Drizzle database (from `@dorkos/db` `createDb`).
 */
export function createAuth(db: Db) {
  return betterAuth({
    appName: 'DorkOS',
    // `baseURL` is intentionally omitted: this server is reachable on both a
    // loopback origin and a dynamic ngrok tunnel, so Better Auth must derive the
    // origin per request rather than from one fixed URL. Better Auth logs a
    // one-time "Base URL is not set" advisory at startup — expected and harmless
    // here (email/password + API keys only; no OAuth redirects). Origin policy
    // lives in `trustedOrigins` below.
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      // Explicit table map so the adapter never has to guess model → table
      // among the other (non-auth) tables in the consolidated schema.
      schema: { user, session, account, verification, apikey },
    }),
    // Local accounts: email is an identifier only. No verification, no SMTP.
    // Password hashing stays the Better Auth default (scrypt).
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    user: {
      additionalFields: {
        // Marks the first user as 'owner'; nullable + server-only (never
        // client-settable). Kept multi-user-capable for the invites spec.
        role: { type: 'string', required: false, input: false },
      },
    },
    session: {
      // Signed short-TTL session snapshot in a cookie so hot paths (SSE
      // reconnect, high-frequency polling) avoid a DB read per request.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    // Per-user scoped API keys (consumed by tasks 1.2 and 1.4).
    plugins: [apiKey()],
    // CSRF/origin surface: reuse the dynamic origin policy (loopback dev origins
    // + live tunnel origin) shared with the CORS allowlist.
    trustedOrigins: () => resolveTrustedOrigins(),
    advanced: {
      // Secure in production; `trust proxy` in app.ts keeps this correct behind
      // the ngrok hop. `sameSite: 'lax'` is required by the P2 device flow and
      // OAuth callbacks.
      useSecureCookies: isProduction,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (userData) => {
            // Owner-only registration: allow sign-up only while the user table
            // is empty, and stamp the first user as the owner. (Single-writer
            // local instance, so the empty-table check is race-free enough for
            // P1; the invites spec adds real multi-user provisioning.)
            const existing = db.select({ id: user.id }).from(user).limit(1).get();
            if (existing) {
              throw new APIError('FORBIDDEN', {
                code: 'REGISTRATION_CLOSED',
                message:
                  'Registration is closed. An owner account already exists for this DorkOS instance.',
              });
            }
            return { data: { ...userData, role: 'owner' } };
          },
        },
      },
    },
  });
}

let activeAuth: Auth | undefined;

/**
 * Create the Better Auth singleton over the server's Drizzle db and store it for
 * `app.ts` and downstream auth consumers. Called once at startup.
 *
 * @param db - The server's Drizzle database (from `@dorkos/db` `createDb`).
 */
export function initAuth(db: Db): Auth {
  activeAuth = createAuth(db);
  return activeAuth;
}

/**
 * The initialized Better Auth singleton, or `undefined` when auth has not been
 * initialized (e.g. unit tests that build the app without calling
 * {@link initAuth}). In the running server `initAuth` always runs before
 * `createApp`, so the handler is always mounted.
 */
export function getAuth(): Auth | undefined {
  return activeAuth;
}

// Re-exported for downstream auth consumers (e.g. the session-gate in task
// 1.2): `toNodeHandler` mounts the handler; `fromNodeHeaders` converts an
// Express request's headers to a Web `Headers` for `auth.api.getSession`.
export { toNodeHandler, fromNodeHeaders };
