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
import { deviceAuthorization } from 'better-auth/plugins';

import { account, apikey, deviceCode, session, user, verification } from '@/db/auth-schema';
import { getDb } from '@/db/client';
import { instance } from '@/db/instance-schema';
import { env } from '@/env';
import { INSTANCE_PERMISSION_RESOURCE, parseInstanceDescriptor } from '@/lib/instance-descriptor';
import { instanceRegistry } from '@/lib/instance-registry-plugin';
import { createInstanceApiKey } from '@/lib/instance-service';
import { sendResetPassword, sendVerificationEmail } from '@/lib/mailer';

/** Device-authorization user + device code lifetime (RFC 8628). */
const DEVICE_CODE_EXPIRES_IN = '30m';
/** Minimum interval between device-token polls before `slow_down` fires. */
const DEVICE_POLL_INTERVAL = '5s';
/** Length of the human-typed user code shown at `/activate`. */
const DEVICE_USER_CODE_LENGTH = 8;

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

  const auth = betterAuth({
    appName: 'DorkOS',
    baseURL: env.BETTER_AUTH_URL,
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
    ],
    hooks: {
      // Swap the device-flow session for a scoped API key. By default
      // `/device/token` mints a browser session on approval; an instance must
      // instead hold a revocable, account-scoped API key. On a successful token
      // response we mint that key (metadata = the instance descriptor), discard
      // the just-created session, and rewrite the body to carry the key.
      after: createAuthMiddleware(async (ctx) => {
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
type ProductionAuthEnv = Pick<typeof env, 'NODE_ENV' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL'>;

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
  if (LOCALHOST_ORIGIN.test(e.BETTER_AUTH_URL)) {
    problems.push('BETTER_AUTH_URL must be a non-localhost public origin');
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
      // `apikey` + `deviceCode` back the plugins; `instance` backs the registry.
      schema: { user, session, account, verification, apikey, deviceCode, instance },
    })
  );
  return cached;
}
