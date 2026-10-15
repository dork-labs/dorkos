import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One thing an agent promised somebody (spec `heartbeats` §12, canon
 * PROACTIVE-AGENTS §5.5): what, to whom, by when, and how it ended.
 *
 * Kept by DorkOS rather than in a chat, so anyone in the space can read every
 * agent's list. Overdue is never stored: it is `open` with `due_at` in the
 * past, computed when a row is read.
 */
export const commitments = sqliteTable(
  'commitments',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The Mesh id of the agent that promised. */
    agentId: text('agent_id').notNull(),
    /**
     * To whom: a person's account, an agent id, or `external:<label>` for an
     * outsider. NULL when nobody was named.
     */
    toAccount: text('to_account'),
    /** What was promised, in one plain line (at most 300 characters). */
    what: text('what').notNull(),
    /** When it is due (ISO 8601), or NULL when no date was given. */
    dueAt: text('due_at'),
    /** Where it stands. */
    state: text('state', { enum: ['open', 'kept', 'missed', 'dropped'] }).notNull(),
    /** The chat the promise was made in, or NULL. */
    sourceSessionId: text('source_session_id'),
    /** The room message the promise was made in, or NULL. */
    sourceRoomEntryId: text('source_room_entry_id'),
    /** When it was recorded (ISO 8601). */
    createdAt: text('created_at').notNull(),
    /**
     * When the agent was woken about the current `due_at` (ISO 8601), or NULL
     * when it has not been. Cleared whenever `due_at` moves, so a wake is never
     * repeated for the same date, across restarts included.
     */
    dueNotifiedAt: text('due_notified_at'),
    /** When it left `open` (ISO 8601), or NULL while open. */
    closedAt: text('closed_at'),
    /** A short note on how it ended or why it moved, or NULL. */
    note: text('note'),
  },
  (table) => [
    index('commitments_agent_state_idx').on(table.agentId, table.state),
    index('commitments_due_idx').on(table.dueAt),
    check('commitments_state', sql`${table.state} IN ('open', 'kept', 'missed', 'dropped')`),
    check('commitments_what_length', sql`length(${table.what}) <= 300`),
  ]
);

/** A row of {@link commitments}. */
export type CommitmentRow = typeof commitments.$inferSelect;

/** An insertable row of {@link commitments}. */
export type NewCommitmentRow = typeof commitments.$inferInsert;
