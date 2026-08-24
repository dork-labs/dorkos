/**
 * Drizzle rows to the domain objects the rest of DorkOS passes around.
 *
 * Lifted out of `task-store.ts` (DOR-1482) so the store file stays about
 * PERSISTENCE — what is written, when, and under what guard — rather than also
 * carrying the row-to-object shape. Nothing here reads or writes the database.
 *
 * @module services/tasks/task-row-mappers
 */
import type { pulseSchedules, pulseRuns } from '@dorkos/db';
import type { Task, TaskRun, TaskRunStatus, TaskRunTrigger } from '@dorkos/shared/types';

/**
 * Convert a Drizzle schedule row to a Task object.
 *
 * `proposedByName` and `nextRuns` are left at their empty values here on
 * purpose. Both are resolved when a task is READ by something that can answer
 * them — the name from the agent-identity service (async, and the store is a
 * synchronous data layer), the run times from the scheduler — so the store
 * never caches an answer that can go stale between a write and a read.
 */
export function mapTaskRow(row: typeof pulseSchedules.$inferSelect): Task {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName ?? null,
    description: row.description ?? null,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    agentId: row.agentId ?? null,
    enabled: row.enabled,
    maxRuntime: row.maxRuntime,
    permissionMode: row.permissionMode,
    status: row.status as Task['status'],
    filePath: row.filePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reason: row.reason ?? null,
    proposedBySessionId: row.proposedBySessionId ?? null,
    proposedByAgentPath: row.proposedByAgentPath ?? null,
    proposedByName: null,
    origin: row.origin ?? null,
    reasonSource: row.reasonSource ?? null,
    nextRun: null,
    nextRuns: [],
  } as Task;
}

/** Convert a Drizzle run row to a TaskRun object. */
export function mapRunRow(row: typeof pulseRuns.$inferSelect): TaskRun {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    status: row.status as TaskRunStatus,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    outputSummary: row.output,
    error: row.error,
    sessionId: row.sessionId,
    trigger: row.trigger as TaskRunTrigger,
    createdAt: row.createdAt,
  };
}
