import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/**
 * Append-only activity event log.
 * Stores lightweight summary rows for all trackable events.
 * Never update rows — only insert and prune old rows.
 */
export const activityEvents = sqliteTable(
  'activity_events',
  {
    /** ULID — lexicographically sortable, unique. */
    id: text('id').primaryKey(),

    /** When the event occurred. ISO 8601 UTC. Primary sort key. */
    occurredAt: text('occurred_at').notNull(),

    /** Actor type: who triggered this event. */
    actorType: text('actor_type', {
      enum: ['user', 'agent', 'system', 'tasks'],
    }).notNull(),

    /** Actor identifier. Agent ID, schedule ID, or null for user/system. */
    actorId: text('actor_id'),

    /** Human-readable actor name. "You", agent name, "Tasks", "System". */
    actorLabel: text('actor_label').notNull(),

    /** Event category for filtering. */
    category: text('category', {
      enum: ['tasks', 'relay', 'agent', 'config', 'system', 'permissions'],
    }).notNull(),

    /**
     * Dot-notation event type.
     * Format: `{resource}.{verb}` — e.g., "adapter.added", "tasks.run_success".
     */
    eventType: text('event_type').notNull(),

    /** Resource type for linking: "adapter", "extension", "schedule", "agent". */
    resourceType: text('resource_type'),

    /** Stable resource ID for detail view linking. */
    resourceId: text('resource_id'),

    /** Human-readable resource name. Adapter name, schedule name, etc. */
    resourceLabel: text('resource_label'),

    /** One-line summary. "daily-digest ran successfully (2m 14s)". */
    summary: text('summary').notNull(),

    /** Client-side route path for "Open →" link. e.g., "/agents". */
    linkPath: text('link_path'),

    /** JSON blob for event-specific metadata. Never stores secrets or message content. */
    metadata: text('metadata'),

    /** Row insert time. ISO 8601 UTC. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_activity_occurred_at').on(table.occurredAt),
    index('idx_activity_category').on(table.category),
    index('idx_activity_actor_type').on(table.actorType),
  ]
);
