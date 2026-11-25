import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The chats whose latest turn read words from outside the team (DOR-4148): the outside-words note
 * `services/core/turn-power/outside-words.ts` keeps, saved so a restart cannot clear it. A row
 * means noted; a clean turn deletes its row, so the table only ever holds chats noted right now.
 *
 * Its own table on purpose, not a `session_metadata` column: writing the note must never create a
 * chat's metadata row, which other checks read as "this chat is known".
 */
export const sessionOutsideWords = sqliteTable('session_outside_words', {
  /** The id the note was written under, exactly as its writer held it. */
  sessionId: text('session_id').primaryKey(),
  /** When the note was written (ISO 8601). */
  notedAt: text('noted_at').notNull(),
});

/** A row of {@link sessionOutsideWords}. */
export type SessionOutsideWordsRow = typeof sessionOutsideWords.$inferSelect;
