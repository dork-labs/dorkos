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
import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `user` — one row per DorkOS account. `email` is unique; `emailVerified`
 * gates sign-in (verification is required for cloud accounts, unlike the local
 * server where email is an identifier only).
 *
 * The `role`/`banned`/`banReason`/`banExpires` columns back the Better Auth
 * `admin` plugin (cloud-account-management). Better Auth's Drizzle adapter maps
 * a model field to the drizzle **property key** (`banReason`), never the SQL
 * column string, so the snake_case column names below are free to follow this
 * file's convention while the plugin still resolves each field. `role` defaults
 * to `'user'`; an admin is any account whose `role` is in the plugin's
 * `adminRoles` (or whose id is in `adminUserIds`).
 */
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  // Better Auth `admin` plugin fields. `role` is NOT NULL + default so the
  // additive migration backfills every existing row to 'user'; the ban fields
  // are nullable (null = not banned). `banExpires` null with `banned` true is a
  // permanent ban.
  role: text('role').notNull().default('user'),
  banned: boolean('banned'),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
});

/**
 * `session` — active Better Auth sessions. `userId` references `user.id` within
 * the account cluster (an allowed intra-account FK; the telemetry boundary is
 * never crossed). `impersonatedBy` (Better Auth `admin` plugin) holds the
 * impersonating admin's `user.id` while an admin is impersonating this account;
 * null on ordinary sessions. It is deliberately NOT a foreign key (matching the
 * plugin's generated schema) — it is an audit pointer, not a lifecycle link.
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
  impersonatedBy: text('impersonated_by'),
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

/**
 * `apikey` — scoped API keys owned by a DorkOS account (Better Auth `apiKey`
 * plugin, `@better-auth/api-key`). Device-linked instances hold a key here
 * (never a browser session): the key value is stored hashed in `key`,
 * `referenceId` is the owning `user.id`, and `metadata` carries the instance
 * descriptor (`{ instanceId, name, platform, dorkosVersion, scope }`). Column
 * shapes mirror what the plugin generates; the runtime adapter in `src/lib/auth.ts`
 * reads these exact camelCase field names, so treat this as the contract.
 *
 * `referenceId` is an owning-user pointer but is deliberately **not** a declared
 * FK here (matching the plugin's generated schema); it never crosses the
 * telemetry boundary.
 */
export const apikey = pgTable('apikey', {
  id: text('id').primaryKey(),
  configId: text('config_id').notNull().default('default'),
  name: text('name'),
  start: text('start'),
  referenceId: text('reference_id').notNull(),
  prefix: text('prefix'),
  key: text('key').notNull(),
  refillInterval: integer('refill_interval'),
  refillAmount: integer('refill_amount'),
  lastRefillAt: timestamp('last_refill_at'),
  enabled: boolean('enabled').default(true),
  rateLimitEnabled: boolean('rate_limit_enabled').default(true),
  rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
  rateLimitMax: integer('rate_limit_max').default(10),
  requestCount: integer('request_count').default(0),
  remaining: integer('remaining'),
  lastRequest: timestamp('last_request'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  permissions: text('permissions'),
  metadata: text('metadata'),
});

/**
 * `device_code` — RFC 8628 device-authorization records (Better Auth
 * `deviceAuthorization` plugin, model name `deviceCode`). One row per device-link
 * attempt: `deviceCode` is polled by the instance, `userCode` is what the human
 * types at `/activate`, `status` walks `pending → approved | denied`, and `scope`
 * carries the JSON instance descriptor the instance sent on `POST /device/code`.
 * Records are short-lived (30-minute `expiresAt`) and consumed on token exchange.
 */
export const deviceCode = pgTable('device_code', {
  id: text('id').primaryKey(),
  deviceCode: text('device_code').notNull(),
  userCode: text('user_code').notNull(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  status: text('status').notNull(),
  lastPolledAt: timestamp('last_polled_at'),
  pollingInterval: integer('polling_interval'),
  clientId: text('client_id'),
  scope: text('scope'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
