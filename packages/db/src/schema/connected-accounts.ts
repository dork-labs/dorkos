import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/**
 * Derived cache binding an opaque `ConnectedAccountId` to its owning connector
 * provider (ADR-0043 pattern, connector-gateway spec §Detailed Design 2).
 *
 * This is NOT the source of truth for the tokens — the provider vaults own
 * those (Composio's cloud vault, a self-hosted Nango's Postgres, the remote MCP
 * server itself). The table exists only so the server can route
 * `toolServerForAccount`/`disconnect` to the backend that owns an id without
 * leaking the vendor into session code, and so `listAccounts` can aggregate
 * cheaply. Written on a successful `pollConnect` (first-write-wins, mirroring
 * `runtimeRegistry`, ADR-0255) and cleared on `disconnect`; never hand-edited.
 *
 * `provider` is server-only — it is stripped from the session-facing account
 * DTO so the tool surface never sees which backend is behind a connection.
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
