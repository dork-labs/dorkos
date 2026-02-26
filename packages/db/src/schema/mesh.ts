import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Registered mesh agents. Replaces mesh/mesh.db 'agents' table. */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(),
  runtime: text('runtime').notNull(),
  projectPath: text('project_path').notNull().unique(),
  namespace: text('namespace').notNull().default('default'),
  capabilities: text('capabilities_json').notNull().default('[]'), // JSON array
  entrypoint: text('entrypoint'),
  version: text('version'),
  description: text('description'),
  approver: text('approver'),
  status: text('status', {
    enum: ['active', 'inactive'],
  })
    .notNull()
    .default('active'),
  lastSeenAt: text('last_seen_at'), // ISO 8601 TEXT
  lastSeenEvent: text('last_seen_event'),
  registeredAt: text('registered_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // manifest_json DROPPED — redundant with individual structured columns
});

/** Paths denied from mesh registration. Replaces 'denials' table. */
export const agentDenials = sqliteTable('agent_denials', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  reason: text('reason'),
  denier: text('denier'),
  createdAt: text('created_at').notNull(),
});

/**
 * Sliding-window rate limiting buckets per agent per minute.
 * Replaces 'budget_counters' table.
 */
export const rateLimitBuckets = sqliteTable(
  'rate_limit_buckets',
  {
    agentId: text('agent_id').notNull(),
    bucketMinute: integer('bucket_minute').notNull(), // minutes since Unix epoch
    count: integer('count').notNull().default(0),
  },
  (table) => [uniqueIndex('idx_rate_limit_agent_minute').on(table.agentId, table.bucketMinute)],
);
