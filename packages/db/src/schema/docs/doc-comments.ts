import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Comment threads on docs (DOR-2983): one row per thread, anchored to some
 * words of a markdown file.
 *
 * Kept beside the file rather than in it, so the markdown stays exactly what
 * its author wrote. A doc has no table of its own yet: a thread names its doc
 * by `doc_key` (an opaque hash of the doc's folder and path, from
 * `services/docs/doc-space.ts`), and keeps `space_key` and `doc_path` beside
 * it so a thread can still be read back when the folder is renamed one day.
 *
 * `anchor_json` is the editor's opaque anchor (`@blintz/comments`): DorkOS
 * stores it and hands it back, and never reads inside it.
 */
export const docCommentThreads = sqliteTable(
  'doc_comment_threads',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The doc: `docKey(space, path)`. Every read is by this key. */
    docKey: text('doc_key').notNull(),
    /** The doc's space: `resolveDocSpace(cwd).key`. */
    spaceKey: text('space_key').notNull(),
    /** The doc's path inside its space, normalized (`normalizeDocPath`). */
    docPath: text('doc_path').notNull(),
    /** Where the thread sits in the text, as the editor made it (JSON). */
    anchorJson: text('anchor_json').notNull(),
    /** Whether somebody marked it done. */
    resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false),
    /** When it was marked done (ISO 8601), or null. */
    resolvedAt: text('resolved_at'),
    /** Who marked it done (a room author id), or null. */
    resolvedByAuthorId: text('resolved_by_author_id'),
    /** Who opened it (a room author id). */
    createdByAuthorId: text('created_by_author_id').notNull(),
    /** When it was opened (ISO 8601). */
    createdAt: text('created_at').notNull(),
    /** When anything in it last changed (ISO 8601). */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('doc_comment_threads_doc_idx').on(table.docKey)]
);

/** A row of {@link docCommentThreads}. */
export type DocCommentThreadRow = typeof docCommentThreads.$inferSelect;

/**
 * The comments in a thread, oldest first.
 *
 * `cascade_root` and `cascade_depth` are the room cascade guard's provenance
 * (`services/rooms/cascade-guard.ts`), carried on comments for the same
 * reason they are carried on room entries: a comment that mentions an agent
 * wakes it, and an agent's comment that mentions another agent may only wake
 * it inside the same bounded chain.
 */
export const docComments = sqliteTable(
  'doc_comments',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The thread. Deleting a thread deletes its comments. */
    threadId: text('thread_id')
      .notNull()
      .references(() => docCommentThreads.id, { onDelete: 'cascade' }),
    /** Who wrote it (a room author id). */
    authorId: text('author_id').notNull(),
    /** What they wrote (markdown). */
    body: text('body').notNull(),
    /** Author ids its `@handles` reached, resolved once at write time (JSON array). */
    mentionsJson: text('mentions_json').notNull().default('[]'),
    /**
     * How much its words counted for when it was written: `owner` only for the
     * owner in person, `agent` for one of this computer's agents, `outsider`
     * for anybody else. Kept so a later wake labels it as it was written.
     */
    trust: text('trust', { enum: ['owner', 'agent', 'outsider'] }).notNull(),
    /** The comment that began this chain of automatic replies. */
    cascadeRoot: text('cascade_root').notNull(),
    /** How many automatic replies deep this comment is. A person's comment is 0. */
    cascadeDepth: integer('cascade_depth').notNull().default(0),
    /** When it was written (ISO 8601). */
    createdAt: text('created_at').notNull(),
    /** When its author last changed it (ISO 8601), or null. */
    editedAt: text('edited_at'),
  },
  (table) => [
    index('doc_comments_thread_idx').on(table.threadId),
    index('doc_comments_cascade_idx').on(table.cascadeRoot),
  ]
);

/** A row of {@link docComments}. */
export type DocCommentRow = typeof docComments.$inferSelect;

/**
 * Every agent a doc comment woke, one row per wake sent (DOR-2983).
 *
 * The cascade guard's repeat rule counts these: how many times one agent has
 * been woken in one chain. Written before the wake is dispatched, so two
 * comments arriving together cannot both read a count of zero, and removed
 * when the dispatch was refused, so a wake that never ran costs nothing.
 */
export const docCommentWakes = sqliteTable(
  'doc_comment_wakes',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The comment that began the chain. */
    cascadeRoot: text('cascade_root').notNull(),
    /** The woken agent's author id. */
    agentAuthorId: text('agent_author_id').notNull(),
    /** When the wake was sent (ISO 8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('doc_comment_wakes_cascade_idx').on(table.cascadeRoot)]
);

/** A row of {@link docCommentWakes}. */
export type DocCommentWakeRow = typeof docCommentWakes.$inferSelect;

/**
 * The chat DorkOS keeps with each agent for doc comments that mention it.
 *
 * The first mention opens a chat in the agent's own home; every later one
 * lands in the same chat, so an agent mentioned twice in a minute answers
 * both in one place instead of opening a chat for each.
 */
export const docCommentAgentChats = sqliteTable('doc_comment_agent_chats', {
  /** The Mesh agent id. */
  agentId: text('agent_id').primaryKey(),
  /** The kept chat (canonical id). */
  sessionId: text('session_id').notNull(),
  /** When the chat was opened (ISO 8601). */
  createdAt: text('created_at').notNull(),
});

/** A row of {@link docCommentAgentChats}. */
export type DocCommentAgentChatRow = typeof docCommentAgentChats.$inferSelect;
