/**
 * `instance` — the device-linked instance registry for a **DorkOS account**
 * (accounts-and-auth P2).
 *
 * One row per local DorkOS instance a user has linked to their account via the
 * RFC 8628 device flow. The instance authenticates to the cloud with a scoped
 * API key (in `./auth-schema.ts` `apikey`), never a browser session; this table
 * is the human-facing registry (name, platform, version, last-seen) rendered at
 * `/account/instances`, with per-row revocation.
 *
 * ## Identity link
 *
 * `id` equals the `instanceId` stored in the owning API key's `metadata`, so a
 * heartbeat (which carries only the key) can find and refresh its row, and a
 * revoke can find the key to disable from the row. `userId` is an intra-account
 * FK to `user` — an allowed cluster-internal reference.
 *
 * ## Telemetry isolation (privacy contract)
 *
 * Hard-isolated from `marketplaceInstallEvents` (`./schema.ts`): no foreign key,
 * join column, or shared identifier crosses the account ↔ telemetry boundary.
 * The isolation is enforced by `__tests__/schema.test.ts`. Never add a column
 * here that references a telemetry row, and never add an instance reference to a
 * telemetry table.
 *
 * @module db/instance-schema
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { user } from './auth-schema';

/**
 * `instance` — a device-linked DorkOS instance. `revokedAt` is null while the
 * link is live; setting it (alongside disabling the API key) unlinks the
 * instance, which then detects a 401 on its next cloud call.
 */
export const instance = pgTable('instance', {
  /**
   * Instance id. A Better Auth adapter-generated **string** (`text`, like every
   * other Better Auth model) — deliberately NOT a Postgres `uuid`. The registry
   * is written through the Better Auth adapter (`adapter.create`), which supplies
   * its own string id on insert, so a `uuid` column rejects it at runtime
   * (`invalid input syntax for type uuid`, Postgres 22P02) and the device-link
   * token exchange 500s. Equals the `instanceId` stored in the owning API key's
   * metadata.
   */
  id: text('id').primaryKey(),
  /** Owning DorkOS account (intra-cluster FK to `user`). */
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** Human-readable instance name (e.g. the hostname), refreshed by heartbeat. */
  name: text('name').notNull(),
  /** `process.platform` of the instance (e.g. `darwin`), refreshed by heartbeat. */
  platform: text('platform').notNull(),
  /** DorkOS version the instance is running, refreshed by heartbeat. */
  dorkosVersion: text('dorkos_version').notNull(),
  /** When the instance first linked. */
  createdAt: timestamp('created_at').notNull().defaultNow(),
  /** Last heartbeat receive time (server clock). Drives "last seen" copy. */
  lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
  /** Set when the link is revoked; null while live. */
  revokedAt: timestamp('revoked_at'),
});

/** A row read from `instance`. */
export type Instance = typeof instance.$inferSelect;

/** A row insertable into `instance`. */
export type NewInstance = typeof instance.$inferInsert;
