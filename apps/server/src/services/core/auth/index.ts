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
import { user, session, account, verification, apikey, eq, type Db } from '@dorkos/db';
import { env } from '../../../env.js';
import { logger } from '../../../lib/logger.js';
import { resolveTrustedOrigins } from '../../../lib/trusted-origins.js';
import { findOwnerAccount, type Account } from './accounts.js';
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
 * The `{ id, email, name }` of a user by id, or `null` when unknown — including
 * when auth was never initialized (no db bound) or the id does not resolve to
 * any row.
 *
 * A direct, synchronous better-sqlite3 read against the `user` table, keyed by
 * an id a caller already verified some other way (a session cookie, an API
 * key) — mirroring {@link hasAnyUser} and {@link readOwnerAccount}. The
 * feedback pipeline (feedback-pipeline spec Part 1, ADR 260803-205037) is the
 * first caller: it resolves a reporter's identity server-side, from
 * `sessionGate`'s already-verified `userId`, never from a client-supplied
 * field.
 *
 * @param userId - The Better Auth user id to look up.
 */
export function getUserById(userId: string): { id: string; email: string; name: string } | null {
  if (!activeDb) return null;
  return (
    activeDb
      .select({ id: user.id, email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
      .get() ?? null
  );
}

/**
 * Point an account's `user.image` at a photo, or clear it.
 *
 * The write sibling of {@link getUserById}, and the reason it exists at all:
 * `authors.image_url` is what the roster and every room renderer read, while
 * `user.image` is what the account record holds. A profile photo has to land in
 * both or the two records disagree about the same person (spec
 * `identity-consistency` §W3.5). The one caller is the profile router, which
 * writes them together.
 *
 * A no-op when auth was never initialized — an install with login off has a
 * roster and no `user` row, which is a supported state rather than a failure.
 *
 * @param userId - The Better Auth user id.
 * @param image - The URL the avatar store returned, stored verbatim, or `null`
 *   to clear it.
 */
export function setUserImage(userId: string, image: string | null): void {
  if (!activeDb) return;
  activeDb.update(user).set({ image }).where(eq(user.id, userId)).run();
}

/**
 * Set an account's `user.name` — what this person wants to be called.
 *
 * The sibling of {@link setUserImage}, and it exists for the same reason with
 * one extra edge: `user.name` is the FIRST rung of the roster's name ladder
 * (`services/identity/operator-profile.ts`), so on an install with an account
 * nothing else a person types can change what the roster calls them. The one
 * caller is `PATCH /api/profile`, which writes it beside
 * `config.profile.displayName` so the two rungs cannot disagree.
 *
 * Nullable is deliberately not offered: Better Auth's column is `NOT NULL`, and
 * "no name" is not a thing the profile form can ask for.
 *
 * A no-op when auth was never initialized — an install with login off has a
 * roster and no `user` row, which is a supported state rather than a failure.
 *
 * @param userId - The Better Auth user id.
 * @param name - The name to store, already trimmed and length-checked by the
 *   route's Zod schema.
 */
export function setUserName(userId: string, name: string): void {
  if (!activeDb) return;
  activeDb.update(user).set({ name }).where(eq(user.id, userId)).run();
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
 * The account that owns this install, or `null` when nobody has registered yet
 * (or auth was never initialized — a unit test app built without
 * {@link initAuth}).
 *
 * The request-time reader for {@link findOwnerAccount}, sibling to
 * {@link hasAnyUser} and resolved the same way: a synchronous better-sqlite3
 * read off the retained db handle. The rooms subsystem is what turns on it: it
 * is how `isOwnerAuthor` decides which author id IS this owner, which is the
 * question room authorization asks instead of "is this author a human"
 * (DOR-598).
 */
export function readOwnerAccount(): Account | null {
  if (!activeDb) return null;
  return findOwnerAccount(activeDb);
}

/**
 * Point the account readers at a database WITHOUT standing up Better Auth.
 *
 * For an embedding host that reads who owns the install but serves no auth
 * routes — the Obsidian plugin, which opens the message index in-process and
 * needs {@link readOwnerAccount} to answer truthfully so the rooms domain can
 * decide what the person at the keyboard may search (DOR-1563).
 *
 * **Without it the embed reads as the owner of every install, including ones it
 * does not own.** `readOwnerAccount()` returns `null` when no database is
 * attached, and `null` is also how a brand-new install with no accounts answers
 * — so an unattached reader is indistinguishable from an unowned machine, and
 * `isOwnerRecord` says yes to the local human either way. On an install with
 * **Require login** on, that is every room and every session handed to somebody
 * who has not signed in.
 *
 * It deliberately does not build {@link createAuth}: that resolves and writes a
 * signing secret, mounts handlers and seeds keys, none of which a read-only
 * reader should cause. A host that needs to SERVE auth calls {@link initAuth}
 * instead, which does this and the rest.
 *
 * @param db - The database to read accounts from.
 */
export function attachAccountReader(db: Db): void {
  activeDb = db;
}

/**
 * Let go of a database attached by {@link attachAccountReader}.
 *
 * **A host that closes its database must call this, and the reason is not
 * tidiness.** `activeDb` is module-global. A reader that closed its connection
 * and left the handle here would have every later {@link readOwnerAccount} throw
 * on a closed database — and worse, two panels opening and closing in sequence
 * would have the second one's close poison the first one's still-open handle.
 *
 * It is deliberately unconditional rather than "detach only if it is mine": a
 * host that attached is the only thing that detaches, and a conditional version
 * would silently keep a stale handle in exactly the two-window case that
 * motivates this.
 */
export function detachAccountReader(): void {
  activeDb = undefined;
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
export {
  sessionGate,
  verifyRequestAuth,
  type RequestUser,
  type VerifyRequestAuthOptions,
} from './session-gate.js';

// The legacy MCP key migration (task 1.4). Re-exported so `index.ts` can run the
// startup seed on a clean seam right after `initAuth`.
export { seedLegacyMcpApiKey } from './seed-legacy-mcp-key.js';

// The per-instance local MCP token (DOR-278). Re-exported so `index.ts` resolves
// it at boot on the same auth seam as `initAuth`/`seedLegacyMcpApiKey`. The
// middleware and the config DTO import the cached getter / rotate helper directly
// from `./mcp-local-token.js`.
export { resolveMcpLocalToken } from './mcp-local-token.js';
