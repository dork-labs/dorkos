/** The ledger of agent-made access changes and their undos (spec `agent-grant-autonomy` §5). */
import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** What one ledger row records. */
export const GRANT_CHANGE_KINDS = [
  'narrow_own',
  'narrow_other',
  'exclude_own',
  'exclude_other',
  'approve_read',
  'undo',
] as const;

/** What one ledger row records. See {@link GRANT_CHANGE_KINDS}. */
export type GrantChangeKind = (typeof GRANT_CHANGE_KINDS)[number];

/** Whether a change was made or refused. */
export const GRANT_CHANGE_OUTCOMES = ['applied', 'refused'] as const;

/** Whether a change was made or refused. See {@link GRANT_CHANGE_OUTCOMES}. */
export type GrantChangeOutcome = (typeof GRANT_CHANGE_OUTCOMES)[number];

function inList(values: readonly string[]) {
  return sql.raw(values.map((v) => `'${v}'`).join(', '));
}

/**
 * One access change an agent made (or tried to make), or a person's undo of
 * one. Every allowed change is written in the same transaction as the grant
 * change itself, so a change without a row can't happen; a refusal the rate
 * limit counts is written too.
 *
 * `before_json` and `after_json` hold the target agent's own access on the
 * connection: `{ level, revisionIds, excluded }`. Undo restores `before` only
 * while the current state still equals `after`.
 *
 * `reason` is the agent's own words. It is shown to the person only, as plain
 * text and attributed to the agent, and never handed to another agent.
 */
export const connectionGrantChanges = sqliteTable(
  'connection_grant_changes',
  {
    /** ULID; the id Undo takes. */
    id: text('id').primaryKey(),
    kind: text('kind').$type<GrantChangeKind>().notNull(),
    outcome: text('outcome').$type<GrantChangeOutcome>().notNull(),
    /** The refusal code, on a refused row. */
    refusalCode: text('refusal_code'),
    /** `person` or `agent`. */
    actorKind: text('actor_kind').$type<'person' | 'agent'>().notNull(),
    /** The agent id, or the owner id for a person. */
    actorId: text('actor_id').notNull(),
    /** The session the agent called from, when it had one. */
    actorSessionId: text('actor_session_id'),
    /** The agent whose access changed. */
    targetAgentId: text('target_agent_id').notNull(),
    /** The connection. Kept when the connection is removed, for the record. */
    connectionId: text('connection_id').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    /** The agent's own one-line reason. */
    reason: text('reason'),
    /** On an `approve_read` row, the agent's request it answered. */
    requestId: text('request_id'),
    /** On an `undo` row, the change it undid. */
    undoOf: text('undo_of'),
    /** On a change that was undone, the undo row. */
    undoneBy: text('undone_by'),
    /** ISO time. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('connection_grant_changes_actor_idx').on(table.actorId, table.createdAt),
    index('connection_grant_changes_connection_idx').on(table.connectionId, table.createdAt),
    check('connection_grant_changes_kind', sql`${table.kind} IN (${inList(GRANT_CHANGE_KINDS)})`),
    check(
      'connection_grant_changes_outcome',
      sql`${table.outcome} IN (${inList(GRANT_CHANGE_OUTCOMES)})`
    ),
    check(
      'connection_grant_changes_refusal',
      sql`(${table.outcome} = 'refused') = (${table.refusalCode} IS NOT NULL)`
    ),
    check('connection_grant_changes_actor_kind', sql`${table.actorKind} IN ('person', 'agent')`),
  ]
);

/** A stored `connection_grant_changes` row. */
export type ConnectionGrantChangeRow = typeof connectionGrantChanges.$inferSelect;
