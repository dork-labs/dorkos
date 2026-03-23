/**
 * SQLite-backed TaskStore for A2A task persistence.
 *
 * Implements the `@a2a-js/sdk` `TaskStore` interface using Drizzle ORM
 * against the `a2a_tasks` table. History, artifacts, and metadata are
 * serialized as JSON text columns. Upsert semantics ensure idempotent
 * saves — saving the same task ID twice updates the existing row.
 *
 * @module a2a-gateway/task-store
 */
import type { Task } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import { eq, a2aTasks, type Db } from '@dorkos/db';

/** The status values accepted by the a2a_tasks Drizzle column. */
type DbStatus = typeof a2aTasks.$inferInsert.status;

/** SQLite-backed TaskStore for A2A task persistence. */
export class SqliteTaskStore implements TaskStore {
  constructor(private readonly db: Db) {}

  /** Load a task by ID, returning `undefined` if not found. */
  async load(taskId: string): Promise<Task | undefined> {
    const row = this.db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId)).get();
    return row ? rowToTask(row) : undefined;
  }

  /** Save a task, upserting if the ID already exists. */
  async save(task: Task): Promise<void> {
    const now = new Date().toISOString();
    // The A2A SDK TaskState is a superset of the DB enum — cast to satisfy Drizzle's
    // column type while SQLite stores the raw string regardless.
    const status = task.status.state as DbStatus;
    this.db
      .insert(a2aTasks)
      .values({
        id: task.id,
        contextId: task.contextId,
        agentId: extractAgentId(task),
        status,
        historyJson: JSON.stringify(task.history ?? []),
        artifactsJson: JSON.stringify(task.artifacts ?? []),
        metadataJson: JSON.stringify(task.metadata ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: a2aTasks.id,
        set: {
          contextId: task.contextId,
          status,
          historyJson: JSON.stringify(task.history ?? []),
          artifactsJson: JSON.stringify(task.artifacts ?? []),
          metadataJson: JSON.stringify(task.metadata ?? {}),
          updatedAt: now,
        },
      })
      .run();
  }
}

/** Convert a database row into an A2A Task object. */
function rowToTask(row: typeof a2aTasks.$inferSelect): Task {
  return {
    kind: 'task',
    id: row.id,
    contextId: row.contextId,
    status: {
      state: row.status as Task['status']['state'],
      timestamp: row.updatedAt,
    },
    history: JSON.parse(row.historyJson),
    artifacts: JSON.parse(row.artifactsJson),
    metadata: row.metadataJson !== '{}' ? JSON.parse(row.metadataJson) : undefined,
  };
}

/**
 * Extract the agentId from task metadata.
 * Falls back to 'unknown' when metadata is missing or has no agentId field.
 */
function extractAgentId(task: Task): string {
  return (task.metadata as Record<string, string> | undefined)?.agentId ?? 'unknown';
}
