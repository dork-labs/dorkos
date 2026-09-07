import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/**
 * Historical pre-cutover account table, retained only as Drizzle migration input.
 *
 * The application backfills these rows into canonical connections and drops this
 * table transactionally in `legacy-connection-migration.ts`. Keeping its schema
 * in the generation snapshot prevents a generated SQL DROP from running before
 * that application backfill on an existing installation. It is not exported by
 * the live schema barrel and must never be used for runtime reads or writes.
 */
export const connectedAccounts = sqliteTable(
  'connected_accounts',
  {
    /** Opaque, provider-scoped account handle (the `ConnectedAccountId`). */
    accountId: text('account_id').primaryKey(),
    /** Owning backend type, e.g. `'composio' | 'nango' | 'mcp'` — routes id → provider. */
    provider: text('provider').notNull(),
    /** Service slug this account belongs to, e.g. `'gmail'`. */
    toolkit: text('toolkit').notNull(),
    /** User-facing disambiguator, e.g. `'dorian@personal'` (Composio alias / Nango tag). */
    label: text('label').notNull(),
    /** Custody stance echoed from the provider so each row can disclose per-account. */
    custody: text('custody', {
      enum: ['managed', 'self-host', 'external'],
    }).notNull(),
    /** Lifecycle status of the connection. */
    status: text('status', {
      enum: ['active', 'expired', 'revoked', 'pending'],
    }).notNull(),
    /** ISO 8601 timestamp the binding was first written. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    // Aggregation and degradation group by owning provider, so index it.
    index('connected_accounts_provider_idx').on(table.provider),
  ]
);
