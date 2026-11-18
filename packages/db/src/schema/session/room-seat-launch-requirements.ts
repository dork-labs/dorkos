import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Immutable recovery billing constraints; never proof that a native session exists. */
export const roomSeatLaunchRequirements = sqliteTable(
  'room_seat_launch_requirements',
  {
    id: text('id').primaryKey(),
    destinationSessionId: text('destination_session_id').notNull().unique(),
    sourceSessionId: text('source_session_id').notNull(),
    sourceDispatchId: text('source_dispatch_id').notNull().unique(),
    startSeq: integer('start_seq').notNull(),
    endSeq: integer('end_seq').notNull(),
    payload: text('payload').notNull(),
    state: text('state', { enum: ['pending', 'settled', 'refused'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('room_seat_launch_source_once').on(table.sourceSessionId, table.endSeq)]
);
