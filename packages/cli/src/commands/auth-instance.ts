/**
 * CLI-local Better Auth factory for the `dorkos auth` commands.
 *
 * `apps/server` owns the canonical Better Auth instance
 * (`apps/server/src/services/core/auth/index.ts`), but that factory is coupled
 * to the running server's HTTP context: its `trustedOrigins` pull from the
 * tunnel manager and its cookie flags read the server env. Those are
 * request-time concerns that (a) are irrelevant to a CLI that drives Better
 * Auth's server-side APIs directly (no HTTP, no cookies, no origin checks) and
 * (b) drag server-only modules into the CLI's test graph.
 *
 * This factory reconstructs the **identity-relevant** options verbatim — email +
 * password with the Better Auth default (scrypt) hash, the same `@dorkos/db`
 * table map, the `apiKey` plugin, and the owner-only registration hook — so a
 * credential minted here hashes and verifies **identically** to one the running
 * server would accept. The HTTP-only options (`trustedOrigins`, cookie
 * attributes, cookie cache) are intentionally omitted because the CLI never
 * emits a cookie or answers an origin check. Keep the registration policy here
 * in lock-step with the server factory.
 *
 * @module commands/auth-instance
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { apiKey } from '@better-auth/api-key';
import { user, session, account, verification, apikey, type Db } from '@dorkos/db';

/**
 * Build a Better Auth instance bound to the given Drizzle SQLite database,
 * configured identically (for identity purposes) to the server's `createAuth`.
 *
 * @param db - The consolidated `@dorkos/db` database (from `createDb`).
 */
export function createOwnerAuth(db: Db) {
  return betterAuth({
    appName: 'DorkOS',
    // No `baseURL`, `trustedOrigins`, or cookie config: the CLI calls
    // `auth.api.*` / `auth.$context` in-process, so there is no request origin
    // to check and no cookie to sign. Better Auth logs a one-time "Base URL is
    // not set" advisory here — expected and harmless.
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: { user, session, account, verification, apikey },
    }),
    // Local accounts: email is an identifier only. No verification, no SMTP.
    // Password hashing stays the Better Auth default (scrypt) — the property
    // that makes CLI-minted credentials verify against the running server.
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    user: {
      additionalFields: {
        // Marks the first user as 'owner'; server-only (never client-settable).
        role: { type: 'string', required: false, input: false },
      },
    },
    // Per-user scoped API keys — present so the table map and adapter match the
    // server exactly (the CLI itself does not mint keys).
    plugins: [apiKey()],
    databaseHooks: {
      user: {
        create: {
          before: async (userData) => {
            // Owner-only registration: allow sign-up only while the user table
            // is empty, and stamp the first user as the owner. Mirrors the
            // server factory's hook so `dorkos auth enable` enforces the same
            // single-owner policy the server does.
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
