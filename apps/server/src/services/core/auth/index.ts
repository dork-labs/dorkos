import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import type { DbTransaction } from '@dorkos/db';
import type { OriginalDocTokenIssuanceStage } from '../../canvas/doc-channel/current/current-operation-types.js';
import {
  readFreshOriginalNativeDocTokenHeaderFromOrigin,
  type OriginalNativeDocTokenHeader,
} from '../../canvas/doc-channel/tokens/token-store.js';
import {
  requireOriginalDocTokenIssuanceAuthenticationEntry,
  readOriginalDocTokenIssuanceAuthenticationMessage,
} from '../../canvas/doc-channel/current/current-operation-engine.js';
import { encodeOriginalDocTokenHeaderAuthentication } from '../../canvas/doc-channel/tokens/token-authentication-message.js';
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
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import {
  authAuditAfterHook,
  recordAccountCreated,
  recordSignedIn,
  recordSessionEnded,
} from './auth-audit.js';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { apiKey, defaultKeyHasher } from '@better-auth/api-key';
import { user, session, account, verification, apikey, eq, type Db } from '@dorkos/db';
import { env } from '../../../env.js';
import { logger } from '../../../lib/logger.js';
import { resolveAuthTrustedOrigins } from '../../../lib/trusted-origins.js';
import { findOwnerAccount, type Account } from './accounts.js';
import { resolveBetterAuthSecret } from './secret.js';
import { seedLegacyMcpApiKey } from './seed-legacy-mcp-key.js';

/**
 * The parts of the auth options that shape the instance's TYPE: the plugins
 * (which add endpoints such as `verifyApiKey`) and the extra user field (which
 * adds `role` to every session's user).
 *
 * Written out rather than inferred. From Better Auth 1.7.3 the type inferred
 * from the options literal is too large for the compiler to write out, and an
 * exported function whose type cannot be written fails with TS7056 (DOR-2036).
 * Keep this in step with {@link buildAuthOptions}: adding a plugin there without
 * adding it here is a type error, which is the point.
 */
type AuthOptions = Omit<BetterAuthOptions, 'user' | 'plugins'> & {
  user: { additionalFields: { role: { type: 'string'; required: false; input: false } } };
  plugins: [ReturnType<typeof apiKey>];
};

/** The configured Better Auth instance type (return of {@link createAuth}). */
export type Auth = ReturnType<typeof betterAuth<AuthOptions>>;

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
 * @param port - The validated server port; defaults to the server environment.
 * @throws If a non-default instance's data directory cannot be canonicalized.
 */
export function createAuth(db: Db, dorkHome: string, port = env.DORKOS_PORT): Auth {
  return betterAuth(buildAuthOptions(db, dorkHome, port));
}

/**
 * The Better Auth options for one instance, kept apart from {@link createAuth}
 * so the instance type can be named from them (see {@link Auth}).
 *
 * @param db - The server's Drizzle database.
 * @param dorkHome - The resolved DorkOS data directory.
 * @param port - The validated server port.
 */
function buildAuthOptions(db: Db, dorkHome: string, port: number): AuthOptions {
  // Cookies ignore TCP ports. Keep the primary install's legacy names, but
  // separate other data homes. Canonical home identity stays stable when the
  // desktop selects another fallback port or the same home uses a symlink.
  // Startup creates the home before auth; fail closed if it cannot resolve.
  const cookiePrefix =
    port === 4242
      ? 'better-auth'
      : `better-auth-${createHash('sha256').update(realpathSync(dorkHome)).digest('hex').slice(0, 32)}`;
  return {
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
    //
    // `rateLimit.enabled: false` is load-bearing, not a preference (DOR-489).
    // The plugin's default is a per-key quota of 10 verifications per 24 hours,
    // and it is written into every key's own columns at creation. The CLI holds
    // no cookie — it presents its key on EVERY request — so with login on, the
    // eleventh `dorkos` command of the day used to come back 401 Unauthorized,
    // reading like a revoked key rather than a spent quota.
    //
    // A generous ceiling would only move the cliff, because the counter is a
    // daily quota rather than a defence. It is consulted only AFTER a key has
    // been found and proved valid, so guessing never touches it. What it did
    // cap is a STOLEN valid key, at ten calls a day — which buys nothing worth
    // the cost: ten calls are plenty to read anything worth reading, it slowed
    // the rightful owner by exactly as much, and a leaked key is answered by
    // revoking it. Meanwhile one working session — a CLI loop, an agent driving
    // the operator surface over `/mcp`, an SSE reconnect storm — is unbounded
    // and entirely legitimate. Guessing is answered by a separate per-IP layer
    // this does not touch: `middleware/auth-rate-limit.ts` on the credential
    // endpoints and `middleware/mcp-rate-limit.ts` on `/mcp`.
    //
    // Turning it off at the PLUGIN level (rather than per key at creation) is
    // also what makes the fix retroactive: `evaluateRateLimit` checks this
    // option before it reads the row's `rateLimitEnabled` / `rateLimitMax`
    // columns, so keys minted before this change — including the row
    // `seedLegacyMcpApiKey` inserts — stop being throttled with no migration or
    // backfill. The columns in `packages/db/src/schema/auth.ts` keep their
    // now-inert defaults on purpose: rewriting a SQLite column default means
    // rebuilding the table for zero behavior change.
    plugins: [apiKey({ rateLimit: { enabled: false } })],
    // CSRF/origin surface: the dynamic origin policy (loopback dev origins + the
    // live tunnel origin) plus the operator's explicit `DORKOS_CORS_ORIGIN`
    // list, so the origins this server already answers over HTTP and over the
    // socket are the same ones it will accept a login from. It read only the
    // first half until DOR-1744, which is why the desktop dev renderer could
    // load the whole app and then fail to create the owner account. See
    // `resolveAuthTrustedOrigins` for what it drops and why.
    trustedOrigins: () => resolveAuthTrustedOrigins(),
    advanced: {
      cookiePrefix,
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
          after: async (created) => {
            // The account in the audit log, linked to the install id the log
            // named its owner by until now (spec `audit-trail` §3.2).
            recordAccountCreated(created);
            // Owner-creation seam for the legacy MCP key migration (task 1.4):
            // when the owner is created (the enable-login flow), fold any lingering
            // `config.mcp.apiKey` into an owner-owned Better Auth key so existing
            // MCP clients keep working without a restart. Idempotent + non-throwing,
            // so it can never fail the sign-up it runs inside.
            await seedLegacyMcpApiKey(db);
          },
        },
      },
      // Sign-ins and sign-outs in the audit log (spec `audit-trail` PR2):
      // Better Auth keeps sessions, not their history.
      session: {
        create: { after: async (created) => recordSignedIn(created) },
        delete: { after: async (deleted, ctx) => recordSessionEnded(deleted, ctx?.path) },
      },
    },
    // Failed sign-ins and API keys created or revoked, in the audit log.
    hooks: { after: authAuditAfterHook },
  };
}

const tokenAuthApply = Reflect.apply;
const tokenAuthHmacCreate = createHmac;
const tokenAuthEqual = timingSafeEqual;
const tokenAuthHmacProbe = tokenAuthHmacCreate('sha256', 'dorkos-original-token-method-capture');
const tokenAuthHmacUpdate = tokenAuthHmacProbe.update;
const tokenAuthHmacDigest = tokenAuthHmacProbe.digest;
const tokenAuthScalarJson = JSON.stringify;
const tokenAuthParseJson = JSON.parse;
const tokenAuthDescriptor = Object.getOwnPropertyDescriptor;
const tokenAuthOwnKeys = Object.keys;
const tokenAuthBufferFrom = Buffer.from;
const tokenAuthUtf8Bytes = Buffer.byteLength;
const originalTokenAuthCapturesStarted = new WeakSet<Db>();
const originalTokenAuthCustody = new WeakMap<
  Db,
  {
    home: string;
    databasePath: string;
    key: string;
    ready: boolean;
    auth: Auth | undefined;
  }
>();
const originalTokenAuthentications = new WeakSet<OriginalDocTokenIssuanceStage>();
function requireOriginalTokenAuth(db: Db) {
  requireServerNativeDatabaseQueryCustody(db);
  const own = originalTokenAuthCustody.get(db);
  if (!own || !own.ready || own.auth !== activeAuth || activeDb !== db || !db.$client.open)
    throw new Error('Original token installation authentication unavailable.');
  return own;
}
function originalTokenAuthenticationDigest(db: Db, message: string): string {
  const own = requireOriginalTokenAuth(db);
  // Distinct domain; source facts/restrictions and original canonical auth/Db homes are authenticated.
  const hmac = tokenAuthHmacCreate('sha256', own.key);
  tokenAuthApply(tokenAuthHmacUpdate, hmac, ['dorkos.original-doc-token.issuer.v1\0']);
  tokenAuthApply(tokenAuthHmacUpdate, hmac, [
    tokenAuthApply(tokenAuthScalarJson, JSON, [own.home]),
  ]);
  tokenAuthApply(tokenAuthHmacUpdate, hmac, [
    tokenAuthApply(tokenAuthScalarJson, JSON, [own.databasePath]),
  ]);
  tokenAuthApply(tokenAuthHmacUpdate, hmac, [message]);
  return tokenAuthApply(tokenAuthHmacDigest, hmac, ['hex']) as string;
}
/** No supplied key/message/row can obtain a signature: original active stage is mandatory. */
export function authenticateOriginalDocTokenIssuance(
  stage: OriginalDocTokenIssuanceStage,
  db: Db,
  tx: DbTransaction
): string {
  requireOriginalTokenAuth(db);
  requireOriginalDocTokenIssuanceAuthenticationEntry(stage, db, tx);
  if (originalTokenAuthentications.has(stage))
    throw new Error('Original token already authenticated.');
  originalTokenAuthentications.add(stage);
  const message = readOriginalDocTokenIssuanceAuthenticationMessage(stage, db, tx);
  const authentication = originalTokenAuthenticationDigest(db, message);
  // Message is a fixed encoded scalar vector; issuer payload is its fixed sixteenth own string.
  const fields = tokenAuthApply(tokenAuthParseJson, JSON, [message]) as unknown[];
  const slot = tokenAuthDescriptor(fields, '15');
  if (!slot || typeof slot.value !== 'string')
    throw new Error('Original token issuer unavailable.');
  const envelope =
    '{"payloadJson":' +
    tokenAuthApply(tokenAuthScalarJson, JSON, [slot.value]) +
    ',"authentication":' +
    tokenAuthApply(tokenAuthScalarJson, JSON, [authentication]) +
    '}';
  if (tokenAuthApply(tokenAuthUtf8Bytes, Buffer, [envelope]) > 262144)
    throw new Error('Original token issuer too large.');
  return envelope;
}
/** Verifies durable issuance provenance only. Current source/grants/expiry still require original native gates. */
export function verifyOriginalDocTokenNativeCapsule(
  db: Db,
  retainedHeader: OriginalNativeDocTokenHeader
): string {
  requireOriginalTokenAuth(db);
  const header = readFreshOriginalNativeDocTokenHeaderFromOrigin(retainedHeader, db);
  if (!header) throw new Error('Original token provenance unavailable.');
  if (header.revokedAt !== null || !header.nativeExpiryCurrent)
    throw new Error('Original token is not current.');
  const envelope: unknown = tokenAuthApply(tokenAuthParseJson, JSON, [header.issuerJson]);
  if (!envelope || typeof envelope !== 'object' || tokenAuthOwnKeys(envelope).length !== 2)
    throw new Error('Original token provenance unavailable.');
  const read = (key: string) => {
    const descriptor = tokenAuthDescriptor(envelope, key);
    const value = descriptor && tokenAuthDescriptor(descriptor, 'value');
    if (!value || typeof value.value !== 'string')
      throw new Error('Original token provenance unavailable.');
    return value.value as string;
  };
  const payloadJson = read('payloadJson'),
    authentication = read('authentication');
  if (authentication.length !== 64) throw new Error('Original token provenance unavailable.');
  for (let index = 0; index < authentication.length; index++) {
    const ch = authentication[index]!;
    if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')))
      throw new Error('Original token provenance unavailable.');
  }
  const expected = originalTokenAuthenticationDigest(
    db,
    encodeOriginalDocTokenHeaderAuthentication(header, payloadJson)
  );
  const a = tokenAuthApply(tokenAuthBufferFrom, Buffer, [authentication, 'hex']);
  const b = tokenAuthApply(tokenAuthBufferFrom, Buffer, [expected, 'hex']);
  if (!tokenAuthEqual(a, b)) throw new Error('Original token provenance unavailable.');
  requireOriginalTokenAuth(db);
  return payloadJson;
}

let activeAuth: Auth | undefined;
let activeDb: Db | undefined;

interface OriginalRequestAuthStore {
  db: Db;
  database: Auth['options']['database'];
  plugins: Auth['options']['plugins'];
  plugin: ReturnType<typeof apiKey>;
  pluginSchema: string;
  verifyApiKey: Auth['api']['verifyApiKey'];
  getSession: Auth['api']['getSession'];
}
const originalRequestAuthStores = new WeakMap<object, OriginalRequestAuthStore>();
const originalAuthProofApply = Reflect.apply;
const originalAuthProofGet = WeakMap.prototype.get;
const originalAuthProofSet = WeakMap.prototype.set;
const originalAuthProofFreeze = Object.freeze;
const originalAuthProofStringify = JSON.stringify;
const originalAuthProofHash = defaultKeyHasher;
const originalAuthProofNow = Date.now;
const originalAuthProofTime = Date.prototype.getTime;
const originalAuthProofFinite = Number.isFinite;
/**
 * Capture the initialized installation's refusal-only fresh credential reader.
 * The fixed apiKey factory uses private normalized default hash/storage/config
 * values; its public schema is checked against the original constructor value.
 * @param auth - The exact initialized Better Auth instance.
 * @returns A currentness reader, or undefined for an unsupported/replaced owner.
 */
export function captureOriginalRequestAuthReader(auth: Auth):
  | {
      current(): boolean;
      apiKeyCurrent(token: string, id: string, userId: string): Promise<boolean>;
    }
  | undefined {
  const own: OriginalRequestAuthStore | undefined = originalAuthProofApply(
    originalAuthProofGet,
    originalRequestAuthStores,
    [auth]
  );
  if (!own) return undefined;
  const current = (): boolean => {
    try {
      return (
        activeAuth === auth &&
        activeDb === own.db &&
        own.db.$client.open &&
        auth.options.database === own.database &&
        auth.options.plugins === own.plugins &&
        own.plugins?.length === 1 &&
        own.plugins[0] === own.plugin &&
        originalAuthProofStringify(own.plugin.schema) === own.pluginSchema &&
        auth.api.verifyApiKey === own.verifyApiKey &&
        auth.api.getSession === own.getSession
      );
    } catch {
      return false;
    }
  };
  if (!current()) return undefined;
  return originalAuthProofFreeze({
    current,
    apiKeyCurrent: async (token: string, id: string, userId: string): Promise<boolean> => {
      try {
        if (!current() || !id || !userId) return false;
        const hashed = await originalAuthProofHash(token);
        if (!current()) return false;
        const row = own.db
          .select({
            id: apikey.id,
            configId: apikey.configId,
            referenceId: apikey.referenceId,
            key: apikey.key,
            enabled: apikey.enabled,
            expiresAt: apikey.expiresAt,
          })
          .from(apikey)
          .where(eq(apikey.id, id))
          .get();
        if (
          !current() ||
          !row ||
          row.id !== id ||
          row.configId !== 'default' ||
          row.referenceId !== userId ||
          row.key !== hashed ||
          row.enabled === false
        )
          return false;
        if (row.expiresAt) {
          const expiresAt = originalAuthProofApply(originalAuthProofTime, row.expiresAt, []);
          if (!originalAuthProofFinite(expiresAt) || originalAuthProofNow() > expiresAt)
            return false;
        }
        const owner = own.db.select({ id: user.id }).from(user).where(eq(user.id, userId)).get();
        if (!current() || owner?.id !== userId) return false;
        // Quota was charged by original admission. Exhaustion prevents a NEW
        // request; explicit row revocation/identity/expiry still refuses this one.
        return current();
      } catch {
        return false;
      }
    },
  });
}

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
  // Preserve ordinary Db auth behavior; a non-native/retired Db never receives a signer.
  let nativeOrigin = false;
  try {
    requireServerNativeDatabaseQueryCustody(db);
    nativeOrigin = true;
  } catch {
    /* No token custody. */
  }
  const firstCapture = nativeOrigin && !originalTokenAuthCapturesStarted.has(db);
  if (firstCapture) originalTokenAuthCapturesStarted.add(db);
  const options = buildAuthOptions(db, dorkHome, env.DORKOS_PORT);
  let databasePath: string | undefined, home: string | undefined;
  if (firstCapture) {
    requireServerNativeDatabaseQueryCustody(db);
    const name = db.$client.name;
    // Memory/temporary native Db auth stays valid, but cannot own a restart signer.
    if (name && name !== ':memory:') {
      try {
        const candidate = realpathSync(name),
          candidateHome = realpathSync(dorkHome);
        if (statSync(candidate).isFile() && statSync(candidateHome).isDirectory()) {
          databasePath = candidate;
          home = candidateHome;
        }
      } catch {
        /* No stable physical-file signer; ordinary auth construction continues. */
      }
    }
  }
  const capture =
    firstCapture && databasePath && home && typeof options.secret === 'string'
      ? {
          home,
          databasePath,
          key: options.secret,
          ready: false,
          auth: undefined as Auth | undefined,
        }
      : undefined;
  if (capture) originalTokenAuthCustody.set(db, capture);
  activeAuth = betterAuth(options);
  originalAuthProofApply(originalAuthProofSet, originalRequestAuthStores, [
    activeAuth,
    {
      db,
      database: activeAuth.options.database,
      plugins: activeAuth.options.plugins,
      plugin: options.plugins[0],
      pluginSchema: originalAuthProofStringify(options.plugins[0].schema),
      verifyApiKey: activeAuth.api.verifyApiKey,
      getSession: activeAuth.api.getSession,
    },
  ]);
  if (capture) {
    capture.auth = activeAuth;
    capture.ready = true;
  }
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
  recheckAdmittedRequestAuth,
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
