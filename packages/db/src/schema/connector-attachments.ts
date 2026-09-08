import { sqliteTable, text, primaryKey, index } from 'drizzle-orm/sqlite-core';

/**
 * Historical agent attachments retained only as Drizzle migration input.
 * Application cutover migrates and drops this table transactionally; keeping
 * the generation snapshot prevents SQL from dropping rows before that backfill.
 * This table is absent from the live schema barrel and grants no access.
 */
export const agentConnectorAttachments = sqliteTable(
  'agent_connector_attachments',
  {
    /** The agent (mesh `agentId`) this attachment belongs to. */
    agentId: text('agent_id').notNull(),
    /** The connected account id (`ConnectionId`). */
    accountId: text('account_id').notNull(),
    /** ISO 8601 timestamp the standing attachment was created. */
    attachedAt: text('attached_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.accountId] }),
    index('agent_connector_attachments_account_idx').on(table.accountId),
  ]
);

/**
 * Historical session overrides retained only as Drizzle migration input.
 * Application cutover preserves attached/detached intent in canonical session
 * overrides, then drops this table in the same transaction. Its historical
 * snapshot must remain until every supported upgrade can skip that backfill.
 * This table is absent from the live schema barrel and grants no access.
 */
export const sessionConnectorAttachments = sqliteTable(
  'session_connector_attachments',
  {
    /** The session this override belongs to. */
    sessionId: text('session_id').notNull(),
    /** The connected account id (`ConnectionId`). */
    accountId: text('account_id').notNull(),
    /** `'attached' | 'detached'` — the override direction. */
    state: text('state', { enum: ['attached', 'detached'] }).notNull(),
    /** ISO 8601 timestamp of the most recent attach/detach call. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.accountId] }),
    index('session_connector_attachments_account_idx').on(table.accountId),
  ]
);
