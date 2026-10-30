import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * How an agent's work queue runs (DOR-3462). No row means the defaults, and the
 * default is off: nothing starts on its own until a person turns it on. Every
 * column but the day's count is a person's to set; no agent tool writes them.
 */
export const agentWorkQueues = sqliteTable('agent_work_queues', {
  /** The Mesh id of the agent. */
  agentId: text('agent_id').primaryKey(),
  /** Whether a person turned the queue on. Turning it off is how a person pauses it. */
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** How many of the queue's chats may run at once. */
  target: integer('target').notNull().default(1),
  /** The most chats the queue may start in one UTC day. */
  dailyStartCap: integer('daily_start_cap').notNull().default(20),
  /** The UTC day {@link startsToday} counts (`YYYY-MM-DD`), or NULL before the first start. */
  startsDay: text('starts_day'),
  /** How many chats the queue started on {@link startsDay}. */
  startsToday: integer('starts_today').notNull().default(0),
  /** When this row last changed (ISO 8601). */
  updatedAt: text('updated_at').notNull(),
});

/** A row of {@link agentWorkQueues}. */
export type AgentWorkQueueRow = typeof agentWorkQueues.$inferSelect;

/**
 * The one stop that halts every queue on this install (DOR-3462). One row at
 * most, and no row means not stopped. Only a person's route writes it.
 */
export const workQueueControl = sqliteTable(
  'work_queue_control',
  {
    /** Always 1. */
    id: integer('id').primaryKey(),
    /** Whether a person stopped every queue. */
    stopped: integer('stopped', { mode: 'boolean' }).notNull(),
    /** When it last changed (ISO 8601). */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('work_queue_control_one_row', sql`${table.id} = 1`)]
);

/**
 * One piece of work waiting in, or started from, an agent's queue (DOR-3462).
 *
 * `state` is what keeps an item from starting twice: a start first moves the row
 * from `queued` to `starting` in one statement, and only the caller that moved it
 * launches. Nothing but a person's explicit requeue ever moves a row back after a
 * launch may have happened.
 */
export const agentWorkItems = sqliteTable(
  'agent_work_items',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The Mesh id of the agent whose queue this is. */
    agentId: text('agent_id').notNull(),
    /** Where it sits among the queued items: lowest starts first. */
    position: integer('position').notNull(),
    /** A short title, used for the chat it starts. */
    title: text('title').notNull(),
    /** The first message of the chat it starts. */
    prompt: text('prompt').notNull(),
    /** The folder the chat works in, or NULL for the agent's own. */
    cwd: text('cwd'),
    /** Where it stands. */
    state: text('state', { enum: ['queued', 'starting', 'running', 'ended'] }).notNull(),
    /** How it ended, or NULL before then. */
    outcome: text('outcome', {
      enum: ['finished', 'failed', 'stopped', 'limit', 'interrupted'],
    }),
    /** A short note on why it ended the way it did, or NULL. */
    note: text('note'),
    /** The chat it started, or NULL before then. */
    sessionId: text('session_id'),
    /** The account the chat runs on, or NULL when the usual choice decided. */
    accountId: text('account_id'),
    /** Who queued it. */
    addedBy: text('added_by', { enum: ['person', 'agent'] }).notNull(),
    /** When it was queued (ISO 8601). */
    createdAt: text('created_at').notNull(),
    /** When its chat started (ISO 8601), or NULL. */
    startedAt: text('started_at'),
    /** When it ended (ISO 8601), or NULL. */
    endedAt: text('ended_at'),
  },
  (table) => [
    index('agent_work_items_agent_state_idx').on(table.agentId, table.state, table.position),
    index('agent_work_items_session_idx').on(table.sessionId),
    check(
      'agent_work_items_state',
      sql`${table.state} IN ('queued', 'starting', 'running', 'ended')`
    ),
    check('agent_work_items_title_length', sql`length(${table.title}) <= 80`),
  ]
);

/** A row of {@link agentWorkItems}. */
export type AgentWorkItemRow = typeof agentWorkItems.$inferSelect;
