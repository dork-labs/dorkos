import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Every agent turn a to-do started, or would have (DOR-3088, Security's Must 5): the ledger the
 * to-do caps count from, whatever the rooms' own limits are set to.
 *
 * - `started`: the turn was launched. Counts toward its charge's 10 a day.
 * - `queued`: its charge was past its 10 for the day. It starts the next UTC day.
 * - `retry`: something passing said no (the rooms' hourly limit, a launch that failed). Tried again
 *   on the next check.
 * - `held`: no turn will start by itself. The chain is too deep or the assignee is paused; the
 *   person decides (`reason`).
 */
export const todoTurns = sqliteTable(
  'todo_turns',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The to-do (`commitments.id`). */
    todoId: text('todo_id').notNull(),
    /** The agent the turn runs on. */
    agentId: text('agent_id').notNull(),
    /**
     * Whose spend it counts against: the agent that made the change that asked for it, or
     * `outsider:<id>` for somebody outside the team. NULL only for the person who owns this DorkOS.
     */
    chargedTo: text('charged_to'),
    /** Where it stands. */
    status: text('status', { enum: ['started', 'queued', 'retry', 'held'] }).notNull(),
    /** Why it is held, queued or waiting to retry, or NULL once started. */
    reason: text('reason'),
    /** The UTC day it counts toward (`YYYY-MM-DD`). */
    day: text('day').notNull(),
    /** The chat the turn ran in, once started. */
    sessionId: text('session_id'),
    /** When it was recorded (ISO 8601). */
    createdAt: text('created_at').notNull(),
    /** When it started (ISO 8601), or NULL. */
    startedAt: text('started_at'),
  },
  (table) => [
    index('todo_turns_charge_day_idx').on(table.chargedTo, table.day, table.status),
    index('todo_turns_todo_idx').on(table.todoId),
    index('todo_turns_status_idx').on(table.status, table.day),
    index('todo_turns_session_idx').on(table.sessionId),
    check('todo_turns_status', sql`${table.status} IN ('started', 'queued', 'retry', 'held')`),
  ]
);

/** A row of {@link todoTurns}. */
export type TodoTurnRow = typeof todoTurns.$inferSelect;

/**
 * Every to-do an agent handed a person, by UTC day: what its 5-a-day cap counts (DOR-3088). One
 * row per hand-over, made or reassigned, kept even if the to-do moves on, so moving a to-do away
 * never frees a slot.
 */
export const todoPersonAsks = sqliteTable(
  'todo_person_asks',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The agent that handed it over. */
    agentId: text('agent_id').notNull(),
    /** The to-do. */
    todoId: text('todo_id').notNull(),
    /** The UTC day (`YYYY-MM-DD`). */
    day: text('day').notNull(),
    /** When (ISO 8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('todo_person_asks_agent_day_idx').on(table.agentId, table.day)]
);
