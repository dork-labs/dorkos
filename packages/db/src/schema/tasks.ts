import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Task definitions cached from .md files. Internal table name retained for migration simplicity. */
export const pulseSchedules = sqliteTable('pulse_schedules', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(),
  description: text('description'),
  displayName: text('display_name'),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  prompt: text('prompt').notNull(),
  agentId: text('agent_id'),
  /**
   * Why the schedule should exist, in the proposer's own words. An agent must
   * give one (`tasks_create` requires it); a person creating their own schedule
   * needs no case made to themselves, so their rows are NULL.
   */
  reason: text('reason'),
  /** The session an agent proposed this from, so the operator can read the conversation behind it. */
  proposedBySessionId: text('proposed_by_session_id'),
  /**
   * The working directory of the session that proposed it, which is the key the
   * agent-identity service resolves a display name from. The name itself is
   * deliberately NOT stored: an agent can be renamed or revoked, and a cached
   * name would outlive both.
   */
  proposedByAgentPath: text('proposed_by_agent_path'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  maxRuntime: integer('max_runtime'),
  permissionMode: text('permission_mode').notNull().default('acceptEdits'),
  status: text('status', {
    enum: ['active', 'paused', 'pending_approval'],
  })
    .notNull()
    .default('active'),
  filePath: text('file_path').notNull(), // absolute path to .md file
  tags: text('tags_json').notNull().default('[]'), // JSON array of strings
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Execution history for task runs. Internal table name retained for migration
 * simplicity.
 *
 * Indexed on `session_id` because the session-origin overlay asks this table
 * "did a scheduled run produce this session?" on every session list a person
 * loads AND on every `session_upserted` the global stream fans out — the latter
 * one row at a time, synchronously, on the write path. Without the index that
 * is a full scan of all run history per broadcast (DOR-1141 review).
 */
export const pulseRuns = sqliteTable(
  'pulse_runs',
  {
    id: text('id').primaryKey(), // ULID
    scheduleId: text('schedule_id')
      .notNull()
      // ON DELETE CASCADE: a run is history *of* a schedule and has no meaning
      // without it. Without the cascade, `foreign_keys = ON` turns every delete
      // of a schedule that ever ran into a FOREIGN KEY violation.
      .references(() => pulseSchedules.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['running', 'completed', 'failed', 'cancelled', 'timeout'],
    }).notNull(),
    startedAt: text('started_at').notNull(), // ISO 8601 TEXT
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
    output: text('output'), // was: output_summary
    error: text('error'),
    sessionId: text('session_id'),
    trigger: text('trigger', {
      enum: ['scheduled', 'manual', 'agent'],
    })
      .notNull()
      .default('scheduled'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_pulse_runs_session').on(table.sessionId)]
);

/**
 * Dispatch dedup log (ADR-285): one row per `(taskId, scheduledFireTime)` the
 * scheduler has dispatched. The UNIQUE index makes `INSERT … ON CONFLICT DO
 * NOTHING` an atomic "did I win this tick?" gate across processes sharing the
 * DB, so a scheduled tick fires at most once even if the env gate and leader
 * lock are both bypassed. Pruned on a fixed TTL — it only needs to outlive the
 * seconds-to-minutes window in which a duplicate fire is possible.
 */
export const pulseDispatchLog = sqliteTable(
  'pulse_dispatch_log',
  {
    taskId: text('task_id').notNull(),
    scheduledFireTime: integer('scheduled_fire_time').notNull(), // epoch ms of the cron tick
    dispatchedAt: integer('dispatched_at').notNull(), // epoch ms when the claim was won
  },
  (t) => ({
    taskTick: uniqueIndex('pulse_dispatch_log_task_tick').on(t.taskId, t.scheduledFireTime),
  })
);
