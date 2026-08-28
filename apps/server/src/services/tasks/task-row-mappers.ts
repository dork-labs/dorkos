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
import { EffortLevelSchema } from '@dorkos/shared/schemas';

/**
 * Read a stored effort rung, or `null` for one this build cannot read.
 *
 * `pulse_schedules.effort` is free-form TEXT filled from a SKILL.md, so it can
 * hold a rung a later release removed from the ladder or anything a person typed
 * by hand. Dropping it here — once — is what keeps an unmappable string from
 * reaching a runtime adapter as an `EffortLevel` it then silently ignores.
 *
 * @param stored - The column's value.
 */
function readEffort(stored: string | null): Task['effort'] {
  if (stored == null) return null;
  const parsed = EffortLevelSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

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
    sticky: row.sticky,
    maxRuntime: row.maxRuntime,
    permissionMode: row.permissionMode,
    runtime: row.runtime ?? null,
    model: row.model ?? null,
    // The one column parsed rather than cast, for the reason `rowToSettings`
    // (`core/runtime-registry.ts`) parses the session one: this is free-form
    // TEXT, so what comes back is whatever a SKILL.md put there — including a
    // rung a later release dropped. An unreadable value means "no preference",
    // which is what NULL already means, so it is dropped here rather than
    // travelling as an `EffortLevel` into an adapter that cannot map it.
    effort: readEffort(row.effort),
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
    resolvedRuntime: row.resolvedRuntime ?? null,
    resolvedModel: row.resolvedModel ?? null,
    createdAt: row.createdAt,
  };
}
