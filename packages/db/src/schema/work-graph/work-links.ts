import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * What an edge says about its two ends, read "from <relation> to":
 *
 * - `started`: a chat asked for another chat to be started, recorded in the
 *   step that recorded the start. The child may never have launched (a start
 *   cancelled before its chat ran keeps its link), so readers go through the
 *   lineage query (W3, DOR-4969), which shows it as never started or leaves it
 *   out. A carry to another account is a move, not a start, and is never
 *   written as `started`.
 * - `claims`: a chat claims a ticket or pull request.
 * - `opened`: a chat opened a pull request, a branch or a worktree.
 * - `works_on`: a chat works on a ticket, a pull request or a branch.
 * - `belongs_to`: a thing belongs to another (a run to the chat it ran in).
 * - `produced`: a chat produced a thing (a to-do, a room entry).
 * - `forked_from`: a chat is a fork of another chat.
 * - `rekeyed_from`: a chat's id replaced an older id of the same chat (ADR-0267).
 *
 * New relations are added, never reinterpreted.
 */
export const WORK_LINK_RELATIONS = [
  'started',
  'claims',
  'opened',
  'works_on',
  'belongs_to',
  'produced',
  'forked_from',
  'rekeyed_from',
] as const;

/** One of {@link WORK_LINK_RELATIONS}. */
export type WorkLinkRelation = (typeof WORK_LINK_RELATIONS)[number];

/** The longest stored reference: a worktree's 255-character name with its prefix fits. */
export const WORK_LINK_REF_MAX_LENGTH = 300;

/** The longest `source` word. */
export const WORK_LINK_SOURCE_MAX_LENGTH = 32;

const relationList = sql.raw(WORK_LINK_RELATIONS.map((relation) => `'${relation}'`).join(', '));

/**
 * The work graph's edges (DOR-4968, W2): one row per fact "this chat started,
 * claims, opened, works on or produced that thing", written once, at the moment
 * of the action, by the code that performs it.
 *
 * Append-only: rows are inserted and read, never changed. Two triggers, written
 * by hand in migration `20261124200641_dor4968_work_links`, refuse every UPDATE
 * and DELETE, as `audit_events` does. Drizzle does not know they exist, so a
 * later migration that rebuilds this table must recreate them. An exact repeat
 * of an edge (same `from_ref`, `relation` and `to_ref`) is the same fact and
 * lands no second row (`work_links_edge_unique`); its first `recorded_at` stands.
 *
 * Both ends are stored as one canonical text spelling of an entity reference
 * (`@dorkos/shared/entity-ref`), encoded and decoded by the server's
 * `services/work-graph/work-link-ref.ts`: `dork:chat:<id>` for a DorkOS kind, `DOR-1234`,
 * `owner/repo#42` or `PR #42` for a ticket or pull request, and
 * `branch:<name>` or `worktree:<name>` for the two kinds that have no
 * self-describing text form.
 *
 * Holds ids and refs only, never message text. A branch name is stored as
 * given, so write sites must not pass private names.
 *
 * Lives in this computer's store for now; its move to the space store is
 * DOR-5139 (ADR 261122-173853).
 */
export const workLinks = sqliteTable(
  'work_links',
  {
    /** A ULID. */
    id: text('id').primaryKey(),
    /** The edge's subject, as a stored entity reference. */
    fromRef: text('from_ref').notNull(),
    /** The edge's object, as a stored entity reference. */
    toRef: text('to_ref').notNull(),
    /** One of {@link WORK_LINK_RELATIONS}. */
    relation: text('relation', { enum: WORK_LINK_RELATIONS }).notNull(),
    /** When the edge was first recorded (ISO 8601). */
    recordedAt: text('recorded_at').notNull(),
    /** The chat whose action recorded it, or NULL for the server's own bookkeeping. */
    recordingChatId: text('recording_chat_id'),
    /** What wrote it, as one short word: `server`, `open-pr`, `flow`, ... */
    source: text('source').notNull(),
    /**
     * The turn marks of the chat's turn that recorded it (DOR-5264,
     * `specs/turn-marks`): JSON `{ outsider?: true, teammate?: [...] }`, read
     * from the live turn when the edge is written. `{}` for a known unmarked
     * turn; NULL for the server's own bookkeeping, a write no turn made, and
     * rows from before this column. Added by `ALTER TABLE ADD`, so the
     * append-only triggers stand.
     */
    turnMarks: text('turn_marks'),
  },
  (table) => [
    uniqueIndex('work_links_edge_unique').on(table.fromRef, table.relation, table.toRef),
    index('work_links_to_idx').on(table.toRef, table.relation),
    check('work_links_relation', sql`${table.relation} IN (${relationList})`),
    check(
      'work_links_from_length',
      sql`length(${table.fromRef}) BETWEEN 1 AND ${sql.raw(String(WORK_LINK_REF_MAX_LENGTH))}`
    ),
    check(
      'work_links_to_length',
      sql`length(${table.toRef}) BETWEEN 1 AND ${sql.raw(String(WORK_LINK_REF_MAX_LENGTH))}`
    ),
    check('work_links_not_self', sql`${table.fromRef} <> ${table.toRef}`),
    check(
      'work_links_source',
      sql`length(${table.source}) BETWEEN 1 AND ${sql.raw(String(WORK_LINK_SOURCE_MAX_LENGTH))}`
    ),
    check(
      'work_links_recording_chat_length',
      sql`${table.recordingChatId} IS NULL OR length(${table.recordingChatId}) BETWEEN 1 AND 64`
    ),
  ]
);

/** A row of {@link workLinks}. */
export type WorkLinkRow = typeof workLinks.$inferSelect;
