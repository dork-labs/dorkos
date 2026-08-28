import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { desc } from 'drizzle-orm';

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
  /**
   * Where this row came from, when that is not a person using DorkOS.
   *
   * `file` means discovery found a `schedule:` block in a SKILL.md and made
   * this row from it (DOR-1485). Nobody asked for it through a route, so the
   * approval card must not credit an agent with proposing it — it shows the
   * file instead. NULL is every other row: a person's own schedule, or an
   * agent's proposal, which is told apart by `proposed_by_agent_path`.
   */
  origin: text('origin', { enum: ['file'] }),
  /**
   * Who wrote `reason`.
   *
   * `dorkos` means DorkOS did — "this file changed since you approved it", or a
   * validation complaint naming a broken setting. NULL means the words belong to
   * whoever proposed the schedule, and the approval card quotes them as such.
   * Rendering our own sentence in quotation marks under "Proposed by an agent"
   * put words in an agent's mouth that it never said.
   */
  reasonSource: text('reason_source', { enum: ['dorkos'] }),
  /**
   * The schedule content a person has actually approved, as a content key
   * (prompt + cron; `scheduleContentKey` in `schedule-permission-clamp.ts`).
   *
   * This is the arm grant, and it is POSITIVE on purpose. It used to be inferred
   * from `status`, and that inference sprang a leak every time some other writer
   * touched the column: pausing a row for a vanished file, and again for an
   * unregistered agent, each turned "never approved" into "approved" by writing
   * a status the gate read as consent. A stored key cannot be forged by a status
   * write, so the gate no longer consults `status` at all.
   *
   * NULL means nobody has approved this schedule's current content — the state
   * every file-discovered row starts in, and the state a row returns to the
   * moment its content drifts.
   */
  approvedContentKey: text('approved_content_key'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /**
   * Whether every fire of this schedule RESUMES one persistent session instead
   * of starting a fresh one (DOR-1571).
   *
   * Off (the default) is today's behavior exactly: each run gets its own session,
   * keyed by the run's own id, and carries no context from the run before it. On
   * makes every run of this task share ONE session — `sticky-<taskId>`, derived
   * and stable — so the agent picks up where it left off and can act on "what
   * changed since last time". A cache of the file's `schedule.sticky`, like every
   * other scheduling column here; the SKILL.md is the source of truth.
   */
  sticky: integer('sticky', { mode: 'boolean' }).notNull().default(false),
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
      // `skipped` is a tick the scheduler deliberately did not run — the cap was
      // full when it came round (DOR-1482). `timeout` predates it and no writer
      // produces it; both are terminal, neither is a failure.
      enum: ['running', 'completed', 'failed', 'cancelled', 'timeout', 'skipped'],
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
  (table) => [
    index('idx_pulse_runs_session').on(table.sessionId),
    // Every read of run history is newest-first, and this table is the one that
    // GROWS: a task on a per-minute schedule writes 43,200 rows a month, and
    // until DOR-1482 nothing pruned it between restarts. Without these two, both
    // shapes of that read are a full scan plus a sort of everything.
    //
    // `created_at` alone answers the unfiltered "show me recent runs"
    // (`GET /api/tasks/runs`); the composite answers the per-task reads —
    // `listRuns({ taskId })` and, on the hourly retention sweep, `pruneRuns`,
    // which asks for one task's newest N by exactly this ordering.
    index('idx_pulse_runs_created_at').on(desc(table.createdAt)),
    index('idx_pulse_runs_schedule_created_at').on(table.scheduleId, desc(table.createdAt)),
  ]
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
