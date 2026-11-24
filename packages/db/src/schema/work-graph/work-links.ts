import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * What an edge says about its two ends, read "from <relation> to":
 *
 * - `started`: a chat started another chat.
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
 * Append-only: rows are inserted and read, never changed. An exact repeat of an
 * edge (same `from_ref`, `relation` and `to_ref`) is the same fact and lands no
 * second row (`work_links_edge_unique`); its first `recorded_at` stands.
 *
 * Both ends are stored as one canonical text spelling of an entity reference
 * (`@dorkos/shared/entity-ref`), encoded and decoded by the server's
 * `work-link-store.ts`: `dork:chat:<id>` for a DorkOS kind, `DOR-1234`,
 * `owner/repo#42` or `PR #42` for a ticket or pull request, and
 * `branch:<name>` or `worktree:<name>` for the two kinds that have no
 * self-describing text form.
 *
 * Holds ids and names only: never a path, a hostname or message text.
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
