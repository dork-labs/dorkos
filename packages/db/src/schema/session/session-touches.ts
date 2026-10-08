import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * When the person at this install last touched a chat (spec
 * `your-activity-first` D1): opened it on the chat page, or wrote in it
 * through the app. It is what "Today", the agent click and the chat lists
 * order your chats by, held on the server so the desktop, the phone and a
 * second browser all agree, and a cleared browser profile loses nothing.
 *
 * Keyed by chat alone because an install has exactly one person (D2). Only a
 * person's own request writes a row — a message one agent sends another, a
 * room turn or a task fire never does — so a row is honest on a chat of any
 * origin.
 */
export const sessionTouches = sqliteTable('session_touches', {
  /** The chat's canonical id. */
  sessionId: text('session_id').primaryKey(),
  /** When you last opened it on the chat page (ISO 8601), or NULL when never. */
  openedAt: text('opened_at'),
  /** When you last wrote in it from the app (ISO 8601), or NULL when never. */
  wroteAt: text('wrote_at'),
});

/** A row of {@link sessionTouches}. */
export type SessionTouchRow = typeof sessionTouches.$inferSelect;
