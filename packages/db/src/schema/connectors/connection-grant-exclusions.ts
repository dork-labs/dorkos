/** One agent left out of an every-agent share on one connection (DOR-3961). */
import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { connections } from './connections.js';

/**
 * A deny that wins over every-agent grants for one agent on one connection
 * (DOR-3961, spec `agent-grant-autonomy`). The agent's own named grants still
 * count; only `every_agent` rows stop speaking for it.
 *
 * The deny is read every time grants are matched, never copied into grant
 * rows, so a share made later (Trusted auto-share, a person, the level
 * follower) can't reach an excluded agent. Lifting one sets `revoked_at`; a
 * live row has none, and at most one live row exists per agent and connection.
 */
export const connectionGrantExclusions = sqliteTable(
  'connection_grant_exclusions',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The agent left out. */
    agentId: text('agent_id').notNull(),
    /** The connection whose every-agent share no longer reaches it. */
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    /** Who left it out. */
    createdBy: text('created_by').notNull(),
    /** ISO time it was set. */
    createdAt: text('created_at').notNull(),
    /** Who let it back in, or null while live. */
    revokedBy: text('revoked_by'),
    /** ISO time it was lifted, or null while live. */
    revokedAt: text('revoked_at'),
  },
  (table) => [
    uniqueIndex('connection_grant_exclusions_live_unique')
      .on(table.agentId, table.connectionId)
      .where(sql`"revoked_at" is null`),
    index('connection_grant_exclusions_connection_idx').on(table.connectionId),
    check(
      'connection_grant_exclusions_revoked_pair',
      sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`
    ),
    check('connection_grant_exclusions_agent_id', sql`${table.agentId} <> ''`),
  ]
);

/** A stored `connection_grant_exclusions` row. */
export type ConnectionGrantExclusionRow = typeof connectionGrantExclusions.$inferSelect;
