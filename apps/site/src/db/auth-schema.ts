/**
 * Better Auth core tables for the **DorkOS account** cloud identity
 * (accounts-and-auth P2), on Neon Postgres.
 *
 * This is the durable cloud identity that local instances device-link to. It is
 * a wholly separate identity core from the local server's SQLite Better Auth
 * instance (`packages/db/src/schema/auth.ts`): identities are **never** migrated
 * or shared between the two. Product copy calls this a "DorkOS account" — never
 * "DorkOS Cloud account".
 *
 * ## Telemetry isolation (privacy contract)
 *
 * These account tables are hard-isolated from `marketplaceInstallEvents` in
 * `./schema.ts`: **no foreign keys, no join columns, and no shared identifiers**
 * cross the account ↔ telemetry boundary. The install-telemetry no-PII contract
 * (enforced by `__tests__/schema.test.ts`) stays untouched. Never add a column
 * here that references a telemetry row, and never add an account reference to a
 * telemetry table.
 *
 * ## Regeneration workflow
 *
 * The column shapes below mirror what `@better-auth/cli generate` emits for a
 * Postgres Better Auth config with `emailAndPassword` + social providers. We
 * hand-own the file (rather than depending on `@better-auth/cli`, which forks
 * `drizzle-orm` into a second peer-hash variant and breaks the workspace
 * typecheck). To regenerate when the auth config changes:
 *
 * 1. Temporarily add `@better-auth/cli` as a dev dependency.
 * 2. Run `pnpm --filter @dorkos/site exec better-auth generate` against
 *    `src/lib/auth.ts`; reconcile any new/changed columns into this file
 *    (keep the Postgres types and the isolation contract intact).
 * 3. **Remove** `@better-auth/cli` again so nothing is left in `package.json`.
 * 4. Run `pnpm --filter @dorkos/site db:generate` to refresh the committed SQL
 *    migration under `drizzle/`.
 *
 * The runtime Drizzle adapter (`src/lib/auth.ts`) reads these exact table and
 * column names, so treat this file as the contract.
 *
 * @module db/auth-schema
 */
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `user` — one row per DorkOS account. `email` is unique; `emailVerified`
 * gates sign-in (verification is required for cloud accounts, unlike the local
 * server where email is an identifier only).
 */
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/**
 * `session` — active Better Auth sessions. `userId` references `user.id` within
 * the account cluster (an allowed intra-account FK; the telemetry boundary is
 * never crossed).
 */
export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

/**
 * `account` — credential + social provider links for a `user` (email/password
 * hash lives in `password`; GitHub/Google links carry OAuth tokens).
 */
export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/**
 * `verification` — short-lived tokens for email verification and password
 * reset. Not linked to `user` by FK (Better Auth keys these by `identifier`).
 */
export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
