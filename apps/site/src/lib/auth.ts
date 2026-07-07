/**
 * Better Auth — the **DorkOS account** cloud identity core (accounts-and-auth P2).
 *
 * A second, fully independent Better Auth instance running inside `apps/site`
 * (Next.js on Vercel) over the existing Neon Postgres database. It is the
 * durable "DorkOS account" that local self-hosted instances device-link to. It
 * shares no identities with the local server's SQLite Better Auth instance —
 * accounts are never migrated between the two.
 *
 * What it provides at launch:
 * - Email + password with **required email verification** (Resend-backed, via
 *   the `./mailer.ts` seam).
 * - GitHub and Google social sign-in.
 * - Device linking (accounts-and-auth P2, task 2.3): the `deviceAuthorization`
 *   plugin (RFC 8628) and the `apiKey` plugin. A local DorkOS instance runs the
 *   device flow; on approval an {@link https://better-auth.com/docs/plugins/api-key | apiKey}
 *   scoped to the approving account — **not** a browser session — is issued and
 *   returned to the polling instance (see the `/device/token` after-hook below).
 *
 * ## Structure
 *
 * {@link createAuth} is a pure factory over any Better Auth database adapter, so
 * tests construct an instance over an in-memory adapter with the mailer mocked —
 * no Postgres, no network. {@link getAuth} is the lazily-built production
 * singleton (Neon Postgres via the Drizzle adapter) consumed by the
 * `app/api/auth/[...all]` route handler. The db handle is resolved on first
 * request (not at import) so `next build` never needs `DATABASE_URL`.
 *
 * Session cookies are signed with `BETTER_AUTH_SECRET`; the public origin comes
 * from `BETTER_AUTH_URL`. See `src/env.ts` for every auth env var.
 *
 * @module lib/auth
 */
import { apiKey } from '@better-auth/api-key';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { admin, deviceAuthorization } from 'better-auth/plugins';

import { auditLog } from '@/db/audit-schema';
import { account, apikey, deviceCode, session, user, verification } from '@/db/auth-schema';
import { getDb } from '@/db/client';
import { instance } from '@/db/instance-schema';
import { env } from '@/env';
import { handleAdminAfter } from '@/lib/admin-audit-hook';
import { auditRegistry } from '@/lib/audit-registry-plugin';
import { recordAudit } from '@/lib/audit-service';
import { INSTANCE_PERMISSION_RESOURCE, parseInstanceDescriptor } from '@/lib/instance-descriptor';
import { instanceRegistry } from '@/lib/instance-registry-plugin';
import { createInstanceApiKey } from '@/lib/instance-service';
import {
  sendDeleteAccountVerification,
  sendResetPassword,
  sendVerificationEmail,
} from '@/lib/mailer';

/** Device-authorization user + device code lifetime (RFC 8628). */
const DEVICE_CODE_EXPIRES_IN = '30m';
/** Minimum interval between device-token polls before `slow_down` fires. */
const DEVICE_POLL_INTERVAL = '5s';
/** Length of the human-typed user code shown at `/activate`. */
const DEVICE_USER_CODE_LENGTH = 8;

/** Impersonation session lifetime for the `admin` plugin (seconds). */
const IMPERSONATION_SESSION_DURATION_S = 60 * 60;
/** Reason stored when an admin bans an account without supplying one. */
const DEFAULT_BAN_REASON = 'Violated the DorkOS terms of service';
/** Social providers trusted to auto-link to an existing verified-email account. */
const TRUSTED_LINK_PROVIDERS = ['google', 'github', 'email-password'];

/**
 * The subset of the Better Auth request context the `/device/token` after-hook
 * reads. Typed locally (rather than cast to `any`) because these fields are
 * runtime-internal to Better Auth: `returned` is the endpoint's response body,
 * `newSession` is the session the device-token route just created, and
 * `internalAdapter`/`responseHeaders` let us discard that browser session so the
 * instance holds only the API key.
 */
interface DeviceTokenAfterContext {
  returned?: unknown;
  newSession?: { user?: { id?: string }; session?: { token?: string } } | null;
  responseHeaders?: Headers;
  internalAdapter?: { deleteSession?: (token: string) => Promise<unknown> };
}

/** A Better Auth database adapter (the production Drizzle adapter, or an in-memory adapter in tests). */
type AuthDatabase = BetterAuthOptions['database'];

/** The configured Better Auth instance type (return of {@link createAuth}). */
export type Auth = ReturnType<typeof createAuth>;

const isProduction = env.NODE_ENV === 'production';

/** The env slice {@link resolveBaseURL} reads. */
type BaseURLEnv = Pick<typeof env, 'BETTER_AUTH_URL' | 'VERCEL_ENV' | 'VERCEL_BRANCH_URL'>;

/**
 * Resolve the public origin Better Auth serves from.
 *
 * - **Preview** (Vercel): self-derived from the stable per-branch URL, so every
 *   preview deploy authenticates against its own origin with no hardcoded value.
 * - **Production / local**: the explicit `BETTER_AUTH_URL` (the canonical prod
 *   origin, or localhost in dev).
 *
 * @param e - Env slice (injectable for tests; defaults to the parsed env).
 * @internal Exported for testing.
 */
export function resolveBaseURL(e: BaseURLEnv = env): string {
  if (e.VERCEL_ENV === 'preview' && e.VERCEL_BRANCH_URL) {
    return `https://${e.VERCEL_BRANCH_URL}`;
  }
  return e.BETTER_AUTH_URL;
}

/**
 * Build a DorkOS-account Better Auth instance over the given database adapter.
 *
 * Exported (not just the singleton) so tests can construct an instance over an
 * in-memory adapter and drive sign-up/sign-in without a real Postgres or any
 * network I/O.
 *
 * @param database - The Better Auth database adapter to bind (Drizzle pg in
 *   production; an in-memory adapter in tests).
 */
export function createAuth(database: AuthDatabase) {
  // Lazy self-reference: the `/device/token` after-hook (below) needs the built
  // instance to mint an API key, but the hook only runs at request time — long
  // after construction — so it is filled in before any request. Each createAuth
  // call closes over its own holder, so tests over a memory adapter mint keys on
  // the test instance, never the production singleton. (A const holder rather
  // than a `let`, so the forward reference the closure needs is explicit.)
  const selfRef: { current?: Auth } = {};

  // On preview, a request can arrive via the per-branch alias or the per-deploy
  // URL — trust both, scoped to our own Vercel deploy hosts (never a blanket
  // `*.vercel.app`, which would be a CSRF hole). Production and local rely on
  // Better Auth's default, which trusts the `baseURL` origin.
  const trustedOrigins =
    env.VERCEL_ENV === 'preview'
      ? [env.VERCEL_BRANCH_URL, env.VERCEL_URL].filter(Boolean).map((h) => `https://${h}`)
      : [];

  const auth = betterAuth({
    appName: 'DorkOS',
    baseURL: resolveBaseURL(),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    ...(env.BETTER_AUTH_SECRET ? { secret: env.BETTER_AUTH_SECRET } : {}),
    database,
    // Cloud accounts require a verified email before a session is issued.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user: recipient, url }) => {
        await sendResetPassword({ to: recipient.email, url });
      },
    },
    // Auto-link a social sign-in to an existing account when the email matches
    // and is verified (cloud-account-management decision D-A). Without this, a
    // user who signed up with email/password and later "Sign in with Google"
    // (same address) would get a second, empty account ("my instances vanished").
    // `allowDifferentEmails: false` keeps linking to matching verified emails
    // only — closing the classic auto-link account-takeover vector, which is safe
    // here because verification is already required.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: TRUSTED_LINK_PROVIDERS,
        allowDifferentEmails: false,
      },
    },
    // Self-serve account deletion for GDPR/CCPA erasure (decision D-B). Requires
    // an emailed confirmation token before anything is removed, so a hijacked
    // session cannot silently erase an account. The existing `onDelete: cascade`
    // chain then removes sessions, OAuth links, API keys, and linked instances;
    // the instance 401s on its next heartbeat and self-unlinks. The audit rows
    // are written outside the cascade cluster, so the record survives the erasure.
    user: {
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: async ({ user: recipient, url }) => {
          await sendDeleteAccountVerification({ to: recipient.email, url });
        },
        // Audit is best-effort and fail-open: a logging hiccup must never block a
        // user exercising their right to erasure, so a failed write is swallowed
        // rather than thrown back through the delete flow.
        beforeDelete: async (recipient) => {
          try {
            await recordAudit(selfRef.current as Auth, {
              actorUserId: recipient.id,
              action: 'account.self_delete.requested',
              targetUserId: recipient.id,
            });
          } catch {
            /* never block erasure on an audit write */
          }
        },
        afterDelete: async (recipient) => {
          try {
            await recordAudit(selfRef.current as Auth, {
              actorUserId: recipient.id,
              action: 'account.self_delete.completed',
              targetUserId: recipient.id,
            });
          } catch {
            /* never block erasure on an audit write */
          }
        },
      },
    },
    emailVerification: {
      // Send the verification email as part of sign-up.
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user: recipient, url }) => {
        await sendVerificationEmail({ to: recipient.email, url });
      },
    },
    // Social sign-in at launch. Credentials come from env (empty by default so
    // builds/tests don't require real OAuth apps); the providers still register.
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    advanced: {
      // Secure cookies in production; `sameSite: 'lax'` is required by OAuth
      // callbacks and the device-authorization flow.
      useSecureCookies: isProduction,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
      },
    },
    plugins: [
      // RFC 8628 device flow: the instance requests a code, the human approves it
      // at `/activate`, the instance polls `/device/token`. 8-char user code,
      // 30-minute expiry, 5s poll floor (slow_down backoff) per the spec.
      deviceAuthorization({
        expiresIn: DEVICE_CODE_EXPIRES_IN,
        interval: DEVICE_POLL_INTERVAL,
        userCodeLength: DEVICE_USER_CODE_LENGTH,
        verificationUri: '/activate',
      }),
      // Per-account scoped API keys — the credential a linked instance holds
      // (never a browser session). Also the token an instance sends on heartbeat.
      // Metadata is enabled so each key carries its instance descriptor.
      apiKey({ enableMetadata: true }),
      // Declares the device-link `instance` registry table for the adapter.
      instanceRegistry(),
      // Admin surface (cloud-account-management): ban/unban, impersonate, revoke
      // sessions, set role/password, list/search, remove. A single `admin` role
      // (the default) grants all operations; `adminUserIds` is the break-glass
      // bootstrap so the founder is admin before any admin exists to promote one.
      admin({
        adminRoles: ['admin'],
        adminUserIds: env.ADMIN_USER_IDS,
        impersonationSessionDuration: IMPERSONATION_SESSION_DURATION_S,
        defaultBanReason: DEFAULT_BAN_REASON,
      }),
      // Declares the append-only `audit_log` table for the adapter (written by
      // the admin-action hook below and the self-serve delete hooks above).
      auditRegistry(),
    ],
    hooks: {
      // Swap the device-flow session for a scoped API key. By default
      // `/device/token` mints a browser session on approval; an instance must
      // instead hold a revocable, account-scoped API key. On a successful token
      // response we mint that key (metadata = the instance descriptor), discard
      // the just-created session, and rewrite the body to carry the key.
      after: createAuthMiddleware(async (ctx) => {
        // Admin actions (/admin/*): audit the action and, on ban, disable the
        // target's API keys. Never alters the response; never throws.
        if (ctx.path.startsWith('/admin/')) {
          await handleAdminAfter(ctx, selfRef.current as Auth);
          return;
        }
        if (ctx.path !== '/device/token') return;
        const context = ctx.context as unknown as DeviceTokenAfterContext;
        const returned = context.returned;
        const userId = context.newSession?.user?.id;
        // Errors (authorization_pending / expired_token / access_denied) never
        // create a session, so `newSession` is our success signal.
        if (!userId || !returned || typeof returned !== 'object') return;
        if (!('access_token' in returned)) return;

        const rawScope = (returned as { scope?: unknown }).scope;
        const descriptor = parseInstanceDescriptor(typeof rawScope === 'string' ? rawScope : null);
        const { key } = await createInstanceApiKey(selfRef.current as Auth, { userId, descriptor });

        // Discard the browser session the token route created — an instance must
        // hold only the API key. Best-effort: a lingering session is harmless
        // (never delivered to a browser) but leaving one is untidy.
        const sessionToken = context.newSession?.session?.token;
        if (sessionToken && context.internalAdapter?.deleteSession) {
          try {
            await context.internalAdapter.deleteSession(sessionToken);
          } catch {
            /* hygiene only — never fail the token exchange over cleanup */
          }
        }
        try {
          context.responseHeaders?.delete('set-cookie');
        } catch {
          /* header set may be immutable in some runtimes; ignore */
        }

        return ctx.json({
          access_token: key,
          token_type: 'Bearer',
          scope: INSTANCE_PERMISSION_RESOURCE,
        });
      }),
    },
  });

  selfRef.current = auth;
  return auth;
}

/** The auth env slice {@link assertProductionAuthEnv} validates. */
type ProductionAuthEnv = Pick<
  typeof env,
  'NODE_ENV' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'VERCEL_ENV' | 'VERCEL_BRANCH_URL'
>;

const MIN_SECRET_LENGTH = 32;
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/**
 * Fail closed on a misconfigured production deploy.
 *
 * Runs only inside {@link getAuth} (server request time), never at `next build`
 * (where `NODE_ENV` is `production` but secrets are absent) or on the client, so
 * it cannot break the build the way a parse-time schema refinement would.
 *
 * Without this, a production deploy with `BETTER_AUTH_SECRET` unset would sign
 * sessions with Better Auth's predictable development fallback secret (a
 * session-forgery vector), and a localhost `BETTER_AUTH_URL` would emit
 * verification and OAuth-callback links pointing at localhost.
 *
 * @param e - The env slice to validate (defaults to the parsed process env;
 *   injectable so tests need not mutate `process.env`).
 * @internal Exported for testing.
 */
export function assertProductionAuthEnv(e: ProductionAuthEnv = env): void {
  if (e.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (!e.BETTER_AUTH_SECRET || e.BETTER_AUTH_SECRET.length < MIN_SECRET_LENGTH) {
    problems.push(`BETTER_AUTH_SECRET must be set to a ${MIN_SECRET_LENGTH}+ character secret`);
  }
  // Validate the *resolved* origin: on preview it derives from VERCEL_BRANCH_URL,
  // so a localhost (or default) BETTER_AUTH_URL there is fine; only production
  // (and a preview missing its branch URL) must resolve to a public origin.
  if (LOCALHOST_ORIGIN.test(resolveBaseURL(e))) {
    problems.push('BETTER_AUTH_URL must resolve to a non-localhost public origin');
  }
  if (problems.length > 0) {
    throw new Error(
      `DorkOS account auth is misconfigured for production: ${problems.join('; ')}. ` +
        'Set these in the deployment environment.'
    );
  }
}

let cached: Auth | undefined;

/**
 * The production DorkOS-account Better Auth singleton, built lazily on first
 * call over the Neon Postgres Drizzle adapter. Called per request by the
 * `app/api/auth/[...all]` route handler; the db handle is only resolved here
 * (never at import) so `next build` does not require `DATABASE_URL`.
 *
 * Fails closed via {@link assertProductionAuthEnv} when the production secret or
 * public origin is misconfigured, so a bad deploy errors on the first auth
 * request instead of silently signing sessions with a development secret.
 */
export function getAuth(): Auth {
  assertProductionAuthEnv();
  cached ??= createAuth(
    drizzleAdapter(getDb(), {
      provider: 'pg',
      // Explicit table map so the adapter maps each model to the right table
      // (and never touches the telemetry table in the same schema namespace).
      // `apikey` + `deviceCode` back the plugins; `instance` backs the registry;
      // `auditLog` backs the audit log.
      schema: { user, session, account, verification, apikey, deviceCode, instance, auditLog },
    })
  );
  return cached;
}
