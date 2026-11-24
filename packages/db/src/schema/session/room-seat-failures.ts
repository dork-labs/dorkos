import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The server's own record of a room chat's turn that failed with a server error, kept so one
 * recovery can still happen after a restart (DOR-4626). One row per failed chat, replaced by its
 * next failure. Never a credential: the payload names the account folder and bill it ran on, the
 * turn's level and marks, and nothing a caller supplied.
 */
export const roomSeatFailures = sqliteTable('room_seat_failures', {
  sessionId: text('session_id').primaryKey(),
  /** Which server process wrote the row; only a later process may restore from it. */
  bootId: text('boot_id').notNull(),
  payload: text('payload').notNull(),
  recordedAt: integer('recorded_at').notNull(),
  /** When a recovery claimed the row; a claimed row never authorizes another. */
  consumedAt: integer('consumed_at'),
});
