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
 * Session cookies are signed with a secret {@link resolveBetterAuthSecret}
 * resolves at init: an explicit `BETTER_AUTH_SECRET` env var wins, otherwise a
 * per-instance secret is read from (or generated into) a `0600` file under the
 * dork home. That means a fresh install signs in with zero manual env setup, and
 * the secret survives restarts (rotating it would invalidate every live session).
 * Passing `secret` explicitly also stops Better Auth from throwing its
 * production "default secret" error, which previously 500'd the first sign-in
 * (DOR-242).
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
import { logger } from '../../../lib/logger.js';
import { resolveTrustedOrigins } from '../../../lib/trusted-origins.js';
import { resolveBetterAuthSecret } from './secret.js';
import { seedLegacyMcpApiKey } from './seed-legacy-mcp-key.js';

/** The configured Better Auth instance type (return of {@link createAuth}). */
export type Auth = ReturnType<typeof createAuth>;

const isProduction = env.NODE_ENV === 'production';

/**
 * Whether a Better Auth log call is the benign one-time "Base URL is not set"
 * advisory. Better Auth (1.6.23) emits it at init whenever no fixed `baseURL` is
 * set — which DorkOS does on purpose so the origin is derived per request and
 * the CSRF/redirect trust stays the narrow `trustedOrigins` allowlist. The auth
 * logger drops exactly this message. Matched narrowly by text: if a future
 * Better Auth version reworks the wording the advisory simply reappears in the
 * logs — never a behavior or security change.
 *
 * @param level - The Better Auth log level.
 * @param message - The Better Auth log message.
 * @returns `true` only for the base-URL advisory, which should be suppressed.
 */
export function isBetterAuthBaseUrlAdvisory(level: string, message: string): boolean {
  return level === 'warn' && message.includes('Base URL is not set');
}

/**
 * Build a Better Auth instance bound to the given Drizzle SQLite database.
 *
 * Exported (rather than only the singleton) so integration tests can construct
 * an instance over a throwaway temp database without booting the whole server.
 *
 * @param db - The server's Drizzle database (from `@dorkos/db` `createDb`).
 * @param dorkHome - The resolved DorkOS data directory. Used to resolve (and, on
 *   first boot, persist) the session-signing secret.
 */
export function createAuth(db: Db, dorkHome: string) {
  return betterAuth({
    appName: 'DorkOS',
    // Resolve the signing secret up front: env override → persisted file →
    // freshly generated + persisted. Supplying it explicitly (rather than
    // letting Better Auth read the environment) is what makes login work on a
    // fresh install with no `BETTER_AUTH_SECRET` set — see `secret.ts`.
    secret: resolveBetterAuthSecret(dorkHome),
    // No `baseURL`: this server answers on many origins — loopback, a LAN IP, a
    // dynamic ngrok tunnel, or a reverse proxy — so the origin is derived from
    // each incoming request rather than pinned to one URL. The narrow
    // CSRF/redirect allowlist is `trustedOrigins` below, and it must stay the
    // ONLY origin authority. Better Auth's dynamic-baseURL form
    // (`baseURL: { allowedHosts }`) is deliberately NOT used here: it merges each
    // allowed host into the same trusted-origins list `isTrustedOrigin` consumes
    // for `callbackURL`/`redirectTo`, so a wildcard `['*']` injects the pattern
    // `https://*` and trusts every https origin (an open-redirect / CSRF
    // regression). Omitting `baseURL` keeps that list narrow.
    //
    // The cost of omitting `baseURL` is one benign log line: Better Auth
    // (1.6.23) prints a one-time "Base URL is not set" advisory at init. For the
    // only flows DorkOS runs — email/password + API keys, no OAuth redirects —
    // that advisory is noise on every boot, so the `logger` below drops exactly
    // that message (see {@link isBetterAuthBaseUrlAdvisory}) and forwards
    // everything else to the DorkOS logger.
    logger: {
      log: (level, message, ...args) => {
        if (isBetterAuthBaseUrlAdvisory(level, message)) return;
        if (level === 'error') logger.error(message, ...args);
        else if (level === 'warn') logger.warn(message, ...args);
        else logger.info(message, ...args);
      },
    },
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
          after: async () => {
            // Owner-creation seam for the legacy MCP key migration (task 1.4):
            // when the owner is created (the enable-login flow), fold any lingering
            // `config.mcp.apiKey` into an owner-owned Better Auth key so existing
            // MCP clients keep working without a restart. Idempotent + non-throwing,
            // so it can never fail the sign-up it runs inside.
            await seedLegacyMcpApiKey(db);
          },
        },
      },
    },
  });
}

let activeAuth: Auth | undefined;
let activeDb: Db | undefined;

/**
 * Create the Better Auth singleton over the server's Drizzle db and store it for
 * `app.ts` and downstream auth consumers. Called once at startup. The db handle
 * is retained so {@link hasAnyUser} can answer the exposure guard (task 1.3)
 * without a second db instance.
 *
 * @param db - The server's Drizzle database (from `@dorkos/db` `createDb`).
 * @param dorkHome - The resolved DorkOS data directory (threaded to
 *   {@link createAuth} for signing-secret resolution).
 */
export function initAuth(db: Db, dorkHome: string): Auth {
  activeDb = db;
  activeAuth = createAuth(db, dorkHome);
  return activeAuth;
}

/**
 * Whether at least one user (owner) account exists in the auth `user` table.
 *
 * Returns `false` when auth was never initialized (no db bound — e.g. a unit
 * test app built without {@link initAuth}). Uses a synchronous better-sqlite3
 * read, mirroring the owner-registration hook in {@link createAuth}. The
 * exposure guard reads this to decide whether the instance may be exposed beyond
 * localhost.
 */
export function hasAnyUser(): boolean {
  if (!activeDb) return false;
  return activeDb.select({ id: user.id }).from(user).limit(1).get() !== undefined;
}

/**
 * Whether at least one Better Auth API key exists (any owner-owned or seeded key).
 *
 * Returns `false` when auth was never initialized. Uses a synchronous
 * better-sqlite3 read. `GET /api/config` reads this to report the MCP `authSource`
 * as `'user-keys'` when per-user keys are gating access.
 */
export function hasAnyApiKey(): boolean {
  if (!activeDb) return false;
  return activeDb.select({ id: apikey.id }).from(apikey).limit(1).get() !== undefined;
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

// The session gate + its shared credential verifier. `verifyRequestAuth` is the
// single verification path reused by the rewritten MCP auth middleware (task
// 1.4); `sessionGate` is mounted app-wide in `app.ts`.
export { sessionGate, verifyRequestAuth, type RequestUser } from './session-gate.js';

// The legacy MCP key migration (task 1.4). Re-exported so `index.ts` can run the
// startup seed on a clean seam right after `initAuth`.
export { seedLegacyMcpApiKey } from './seed-legacy-mcp-key.js';

// The per-instance local MCP token (DOR-278). Re-exported so `index.ts` resolves
// it at boot on the same auth seam as `initAuth`/`seedLegacyMcpApiKey`. The
// middleware and the config DTO import the cached getter / rotate helper directly
// from `./mcp-local-token.js`.
export { resolveMcpLocalToken } from './mcp-local-token.js';
