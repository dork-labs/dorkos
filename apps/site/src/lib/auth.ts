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
 *
 * The `apiKey` and `deviceAuthorization` plugins (instance linking) land in a
 * later task; this instance is the identity foundation they build on.
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
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { account, session, user, verification } from '@/db/auth-schema';
import { getDb } from '@/db/client';
import { env } from '@/env';
import { sendResetPassword, sendVerificationEmail } from '@/lib/mailer';

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
  return betterAuth({
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
      // callbacks (and the later device-authorization flow).
      useSecureCookies: isProduction,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
      },
    },
  });
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
      schema: { user, session, account, verification },
    })
  );
  return cached;
}
