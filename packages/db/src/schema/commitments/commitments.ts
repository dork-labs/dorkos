import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Who assigned a to-do: an agent by its Mesh id, a person by their account, or somebody from
 * outside the owner's circle (a guest in a shared space, a bridged chat's user).
 */
export const COMMITMENT_ASSIGNER_KINDS = ['agent', 'person', 'outsider'] as const;

/**
 * The named authorities a row can carry instead of a recorded turn level (DOR-3088):
 *
 * - `legacy`: a row that existed before to-dos. It holds the agent's own words, so it behaves as
 *   it always did. Only the migration writes it; a trigger refuses it on every later write.
 * - `self`: an agent's own promise, made by that agent for itself.
 * - `person`: made, and only ever changed, by the person who owns this DorkOS.
 * - `runtime-default`: an outsider touched it, or nobody could vouch for who did.
 *
 * Any other value is a JSON turn level (`TurnPermissionLevel`): the lowest level of every turn
 * that made or changed the row.
 */
export const COMMITMENT_NAMED_AUTHORITIES = [
  'legacy',
  'self',
  'person',
  'runtime-default',
] as const;

/**
 * One thing someone has to do, assigned to one agent or one person (spec `heartbeats` §12, canon
 * PROACTIVE-AGENTS §5.5, DOR-3088). An agent's promise to itself is the oldest kind; a to-do
 * someone gave an agent or a person is the same record with a different assigner.
 *
 * Kept by DorkOS rather than in a chat, so anyone in the space can read every
 * agent's list. Overdue is never stored: it is `open` with `due_at` in the
 * past, computed when a row is read.
 *
 * Exactly one of `agent_id` and `owner_account` is set (`commitments_owner`). Who assigned it and
 * the power it carries are NOT NULL on purpose: a missing value must never read as permission.
 *
 * Two triggers, written by hand in migration `20261102212635_dor3088_todos`, refuse `legacy` on
 * every insert and update. Drizzle does not know they exist, so a later migration that rebuilds
 * this table must recreate them; `todos-migration.test.ts` fails on the latest schema if it does not.
 */
export const commitments = sqliteTable(
  'commitments',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The Mesh id of the agent it is assigned to, or NULL when a person owns it. */
    agentId: text('agent_id'),
    /** The account of the person it is assigned to, or NULL when an agent owns it. */
    ownerAccount: text('owner_account'),
    /**
     * To whom: a person's account, an agent id, or `external:<label>` for an
     * outsider. NULL when nobody was named.
     */
    toAccount: text('to_account'),
    /** What it is, in one plain line (at most 300 characters). */
    what: text('what').notNull(),
    /** When it is due (ISO 8601), or NULL when no date was given. */
    dueAt: text('due_at'),
    /** Where it stands. */
    state: text('state', { enum: ['open', 'kept', 'missed', 'dropped'] }).notNull(),
    /** The chat it was made in, or NULL. */
    sourceSessionId: text('source_session_id'),
    /** The room message it was made from, or NULL. */
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
    /**
     * The turn marks it was made under (DOR-3036, `specs/turn-marks`): JSON
     * `{ outsider?: true, teammate?: [{ roomId, authorId }] }`, or NULL for an unmarked turn. The
     * beat its due date wakes carries them on, since it reads its words.
     */
    originMarks: text('origin_marks'),
    /** What kind of actor assigned it. Recorded once, never changed. */
    assignedByKind: text('assigned_by_kind', { enum: COMMITMENT_ASSIGNER_KINDS }).notNull(),
    /**
     * Who assigned it: the agent's Mesh id, `owner` for the person who owns this DorkOS, or the
     * outsider's id.
     */
    assignedBy: text('assigned_by').notNull(),
    /**
     * The authority its words carry: one of {@link COMMITMENT_NAMED_AUTHORITIES}, or a JSON turn
     * level. Set by the server only, when the row is made. The to-dos service (DOR-3088) lowers
     * it to the lowest of everyone who later changes the row; until then nothing reads it.
     */
    authority: text('authority').notNull(),
    /**
     * The turn marks its words carry, as JSON (`{}` when none), set alongside {@link authority}.
     * Marks only add up; nothing but a person clears one.
     */
    authorityMarks: text('authority_marks').notNull(),
    /** How many agent-made to-dos led to this one. A person's start at 0. */
    chainDepth: integer('chain_depth').notNull(),
    /** The Mesh ids of every agent already in its chain, as a JSON array, so A → B → A is refused. */
    chainAgents: text('chain_agents').notNull(),
    /** Whether the title is still words carried over from the source message, unedited. */
    titleFromSource: integer('title_from_source', { mode: 'boolean' }).notNull(),
    /** Who wrote the source message, when it came from one, recorded apart from the assigner. */
    sourceAuthor: text('source_author'),
    /** The room it came from or belongs to, or NULL. */
    roomId: text('room_id'),
    /** Short markdown notes, or NULL. */
    notes: text('notes'),
    /** The assignee's own sort key, or NULL when unranked. Compared as a string, never shown. */
    rank: text('rank'),
  },
  (table) => [
    index('commitments_agent_state_idx').on(table.agentId, table.state),
    index('commitments_due_idx').on(table.dueAt),
    index('commitments_owner_state_idx').on(table.ownerAccount, table.state),
    index('commitments_assigned_by_idx').on(table.assignedBy, table.state),
    check('commitments_state', sql`${table.state} IN ('open', 'kept', 'missed', 'dropped')`),
    check('commitments_what_length', sql`length(${table.what}) <= 300`),
    check('commitments_owner', sql`(${table.agentId} IS NULL) <> (${table.ownerAccount} IS NULL)`),
    check(
      'commitments_assigned_by_kind',
      sql`${table.assignedByKind} IN ('agent', 'person', 'outsider')`
    ),
    check(
      'commitments_authority',
      sql`${table.authority} IN ('legacy', 'self', 'person', 'runtime-default') OR (json_valid(${table.authority}) AND json_type(${table.authority}) = 'object')`
    ),
    // A legacy row is an agent's own promise from before to-dos, and nothing else.
    check(
      'commitments_legacy_is_own',
      sql`${table.authority} <> 'legacy' OR (${table.agentId} IS NOT NULL AND ${table.assignedByKind} = 'agent' AND ${table.assignedBy} = ${table.agentId})`
    ),
    check(
      'commitments_authority_marks',
      sql`json_valid(${table.authorityMarks}) AND json_type(${table.authorityMarks}) = 'object'`
    ),
    check('commitments_title_from_source', sql`${table.titleFromSource} IN (0, 1)`),
    check('commitments_chain_depth', sql`${table.chainDepth} >= 0`),
    check(
      'commitments_chain_agents',
      sql`json_valid(${table.chainAgents}) AND json_type(${table.chainAgents}) = 'array'`
    ),
    check(
      'commitments_notes_length',
      sql`${table.notes} IS NULL OR length(${table.notes}) <= 2000`
    ),
    check('commitments_rank_length', sql`${table.rank} IS NULL OR length(${table.rank}) <= 64`),
  ]
);

/** A row of {@link commitments}. */
export type CommitmentRow = typeof commitments.$inferSelect;

/** An insertable row of {@link commitments}. */
export type NewCommitmentRow = typeof commitments.$inferInsert;
