import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/** Task definitions cached from .md files. Internal table name retained for migration simplicity. */
export const pulseSchedules = sqliteTable('pulse_schedules', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(),
  description: text('description'),
  displayName: text('display_name'),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  prompt: text('prompt').notNull(),
  cwd: text('cwd'),
  agentId: text('agent_id'),
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

/** Execution history for task runs. Internal table name retained for migration simplicity. */
export const pulseRuns = sqliteTable('pulse_runs', {
  id: text('id').primaryKey(), // ULID
  scheduleId: text('schedule_id')
    .notNull()
    .references(() => pulseSchedules.id),
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
});
