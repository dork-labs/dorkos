import { eq, desc, and, count, notInArray, like, lt, isNull } from 'drizzle-orm';
import { pulseSchedules, pulseRuns, pulseDispatchLog, type Db } from '@dorkos/db';
import { ulid } from 'ulidx';
import type {
  Task,
  TaskRun,
  TaskRunStatus,
  TaskRunTrigger,
  UpdateTaskRequest,
} from '@dorkos/shared/types';
import type { TaskDefinition } from '@dorkos/skills/types';
import { parseDuration } from '@dorkos/skills/duration';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { logger } from '../../lib/logger.js';

/** Options for listing runs. */
interface ListRunsOptions {
  taskId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/** Server-side input for creating a task from the API route. */
export interface CreateTaskStoreInput {
  name: string;
  displayName?: string;
  description: string;
  prompt: string;
  cron?: string | null;
  timezone?: string | null;
  agentId?: string | null;
  enabled?: boolean;
  maxRuntime?: number | null;
  permissionMode?: string;
  filePath: string;
}

/** Fields that can be updated on a run. */
interface RunUpdate {
  status?: TaskRunStatus;
  finishedAt?: string;
  durationMs?: number;
  outputSummary?: string;
  error?: string;
  sessionId?: string;
}

/**
 * Statuses that end a run's lifecycle. Once a run reaches one of these, its
 * outcome is immutable — no later write (a delayed dispatch acknowledgement,
 * a duplicate handler callback, a restart sweep) may change it. This is the
 * state-machine guard behind DOR-248: synchronous in-process relay delivery
 * can let a handler record `completed` before the publisher's own
 * post-publish `updateRun(..., { status: 'running' })` runs, so the guard
 * has to live here — reordering the caller only fixes the one call site.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<TaskRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/** Whether a run status is terminal (see {@link TERMINAL_RUN_STATUSES}). */
function isTerminalRunStatus(status: TaskRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Persistence layer for Task scheduler data.
 *
 * The DB is a derived cache — files on disk are the source of truth.
 * API routes write files first, then call `upsertFromFile()` or `createTask()`
 * for immediate consistency. The reconciler periodically re-syncs.
 */
export class TaskStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // === Task CRUD ===

  /** Read all tasks from the database. */
  getTasks(): Task[] {
    const rows = this.db.select().from(pulseSchedules).all();
    return rows.map(mapTaskRow);
  }

  /** Get a single task by ID. */
  getTask(id: string): Task | null {
    const row = this.db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get();
    return row ? mapTaskRow(row) : null;
  }

  /** Create a new task and persist to the database. */
  createTask(input: CreateTaskStoreInput): Task {
    const now = new Date().toISOString();
    const id = ulid();

    this.db
      .insert(pulseSchedules)
      .values({
        id,
        name: input.name,
        displayName: input.displayName ?? null,
        description: input.description,
        prompt: input.prompt,
        cron: input.cron ?? '',
        timezone: input.timezone ?? 'UTC',
        agentId: input.agentId ?? null,
        enabled: input.enabled ?? true,
        maxRuntime: input.maxRuntime ?? null,
        permissionMode: input.permissionMode ?? 'acceptEdits',
        status: 'active',
        filePath: input.filePath,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.getTask(id)!;
  }

  /** Update an existing task. Returns the updated task or null if not found. */
  updateTask(id: string, input: UpdateTaskRequest): Task | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (input.name !== undefined) updates.name = input.name;
    if (input.displayName !== undefined) updates.displayName = input.displayName ?? null;
    if (input.description !== undefined) updates.description = input.description;
    if (input.prompt !== undefined) updates.prompt = input.prompt;
    if (input.cron !== undefined) updates.cron = input.cron;
    if (input.timezone !== undefined) updates.timezone = input.timezone ?? 'UTC';
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.maxRuntime !== undefined) {
      updates.maxRuntime =
        typeof input.maxRuntime === 'string' ? parseDuration(input.maxRuntime) : null;
    }
    if (input.permissionMode !== undefined) updates.permissionMode = input.permissionMode;
    if (input.status !== undefined) updates.status = input.status;

    this.db.update(pulseSchedules).set(updates).where(eq(pulseSchedules.id, id)).run();

    return this.getTask(id);
  }

  /** Delete a task by ID. Returns true if found and deleted. */
  deleteTask(id: string): boolean {
    const result = this.db.delete(pulseSchedules).where(eq(pulseSchedules.id, id)).run();
    return result.changes > 0;
  }

  // === Run CRUD ===

  /** Create a new run record. Returns the created run. */
  createRun(taskId: string, trigger: TaskRunTrigger): TaskRun {
    const id = ulid();
    const now = new Date().toISOString();

    this.db
      .insert(pulseRuns)
      .values({
        id,
        scheduleId: taskId,
        status: 'running',
        startedAt: now,
        trigger,
        createdAt: now,
      })
      .run();

    return this.getRun(id)!;
  }

  /**
   * Update fields on an existing run. Returns the updated run or null.
   *
   * A run's outcome is immutable once terminal (`completed`/`failed`/
   * `cancelled`, see {@link isTerminalRunStatus}): this is a no-op that
   * returns the run unchanged. This is the durable fix for DOR-248 — the
   * scheduler's post-publish `status: 'running'` write can lose a race with
   * the handler's own terminal write on synchronous (in-process) relay
   * delivery, and this guard makes that race harmless regardless of which
   * caller loses it.
   */
  updateRun(id: string, update: RunUpdate): TaskRun | null {
    const existing = this.getRun(id);
    if (!existing) return null;

    if (isTerminalRunStatus(existing.status)) {
      logger.debug(
        `TaskStore: ignoring updateRun(${id}) — run is already terminal (${existing.status})`
      );
      return existing;
    }

    this.db
      .update(pulseRuns)
      .set({
        status: update.status ?? existing.status,
        finishedAt: update.finishedAt ?? existing.finishedAt,
        durationMs: update.durationMs ?? existing.durationMs,
        output: update.outputSummary ?? existing.outputSummary,
        error: update.error ?? existing.error,
        sessionId: update.sessionId ?? existing.sessionId,
      })
      .where(eq(pulseRuns.id, id))
      .run();

    return this.getRun(id);
  }

  /** Get a single run by ID. */
  getRun(id: string): TaskRun | null {
    const row = this.db.select().from(pulseRuns).where(eq(pulseRuns.id, id)).get();
    return row ? mapRunRow(row) : null;
  }

  /** List runs with optional task/status filter and pagination. */
  listRuns(opts: ListRunsOptions = {}): TaskRun[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const conditions = [];
    if (opts.taskId) {
      conditions.push(eq(pulseRuns.scheduleId, opts.taskId));
    }
    if (opts.status) {
      conditions.push(
        eq(pulseRuns.status, opts.status as (typeof pulseRuns.status.enumValues)[number])
      );
    }

    const query = this.db
      .select()
      .from(pulseRuns)
      .orderBy(desc(pulseRuns.createdAt))
      .limit(limit)
      .offset(offset);

    if (conditions.length > 0) {
      const rows = query.where(and(...conditions)).all();
      return rows.map(mapRunRow);
    }

    return query.all().map(mapRunRow);
  }

  /** Get all currently running runs. */
  getRunningRuns(): TaskRun[] {
    const rows = this.db.select().from(pulseRuns).where(eq(pulseRuns.status, 'running')).all();
    return rows.map(mapRunRow);
  }

  /** Count total runs, optionally filtered by task. */
  countRuns(taskId?: string): number {
    if (taskId) {
      const result = this.db
        .select({ count: count() })
        .from(pulseRuns)
        .where(eq(pulseRuns.scheduleId, taskId))
        .get();
      return result?.count ?? 0;
    }
    const result = this.db.select({ count: count() }).from(pulseRuns).get();
    return result?.count ?? 0;
  }

  /** Prune old runs, keeping only the most recent `retentionCount` per task. */
  pruneRuns(taskId: string, retentionCount: number): number {
    const keepers = this.db
      .select({ id: pulseRuns.id })
      .from(pulseRuns)
      .where(eq(pulseRuns.scheduleId, taskId))
      .orderBy(desc(pulseRuns.createdAt))
      .limit(retentionCount)
      .all();

    const keeperIds = keepers.map((r) => r.id);

    if (keeperIds.length === 0) {
      const result = this.db.delete(pulseRuns).where(eq(pulseRuns.scheduleId, taskId)).run();
      return result.changes;
    }

    const result = this.db
      .delete(pulseRuns)
      .where(and(eq(pulseRuns.scheduleId, taskId), notInArray(pulseRuns.id, keeperIds)))
      .run();
    return result.changes;
  }

  /**
   * Atomically claim a scheduled dispatch for `(taskId, scheduledFireTime)`
   * (ADR-285). Backed by a UNIQUE index, so `INSERT … ON CONFLICT DO NOTHING`
   * succeeds for exactly one caller per tick across all processes sharing this
   * DB. Returns `true` if THIS caller won the claim (should fire), `false` if the
   * tick was already dispatched (skip).
   *
   * @param taskId - The task being dispatched.
   * @param scheduledFireTime - The cron's intended tick (epoch ms), not wall-clock.
   * @returns Whether this caller may proceed to fire.
   */
  tryClaimDispatch(taskId: string, scheduledFireTime: number): boolean {
    const result = this.db
      .insert(pulseDispatchLog)
      .values({ taskId, scheduledFireTime, dispatchedAt: Date.now() })
      .onConflictDoNothing()
      .run();
    return result.changes === 1;
  }

  /**
   * Prune dispatch-dedup rows whose scheduled tick is older than `ttlMs`. The key
   * only needs to outlive the brief window in which a duplicate fire is possible,
   * so a generous TTL bounds table growth with ample safety margin.
   *
   * @param ttlMs - Age threshold; rows with `scheduledFireTime` older than this are deleted.
   * @returns The number of rows pruned.
   */
  pruneDispatchLog(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    const result = this.db
      .delete(pulseDispatchLog)
      .where(lt(pulseDispatchLog.scheduledFireTime, cutoff))
      .run();
    return result.changes;
  }

  /**
   * Mark all currently running runs as failed (used on startup for crash
   * recovery, DOR-249).
   *
   * Scoped to rows that are genuinely unfinished (`finishedAt IS NULL`) —
   * a `running` row that already carries a real `finishedAt` was completed
   * and is only sitting in `running` due to a status-write race (the
   * `updateRun` terminal guard above closes that race going forward, but
   * this sweep must not assume every writer is patched). Never overwrite an
   * existing `finishedAt`: that timestamp is the only record of when the run
   * actually finished.
   */
  markRunningAsFailed(): number {
    const now = new Date().toISOString();
    const result = this.db
      .update(pulseRuns)
      .set({
        status: 'failed',
        finishedAt: now,
        error: 'Interrupted by server restart',
      })
      .where(and(eq(pulseRuns.status, 'running'), isNull(pulseRuns.finishedAt)))
      .run();
    return result.changes;
  }

  /**
   * Disable all tasks linked to a specific agent ID.
   *
   * @param agentId - The agent ULID whose linked tasks should be disabled
   * @returns The number of tasks that were disabled
   */
  disableTasksByAgentId(agentId: string): number {
    const now = new Date().toISOString();
    const result = this.db
      .update(pulseSchedules)
      .set({ enabled: false, status: 'paused', updatedAt: now })
      .where(and(eq(pulseSchedules.agentId, agentId), eq(pulseSchedules.enabled, true)))
      .run();
    return result.changes;
  }

  // === File-based task sync ===

  /**
   * Upsert a task from a parsed SKILL.md file definition.
   *
   * Looks up existing tasks by `filePath`. If found, updates in place.
   * If not found, inserts a new row with a fresh ULID.
   *
   * @param def - Parsed task definition from a SKILL.md file
   * @param agentId - Agent ID derived from directory location (optional)
   * @returns The upserted Task
   */
  upsertFromFile(def: TaskDefinition, agentId?: string): Task {
    const now = new Date().toISOString();
    const maxRuntimeMs = def.meta['max-runtime'] ? parseDuration(def.meta['max-runtime']) : null;

    const existing = this.db
      .select()
      .from(pulseSchedules)
      .where(eq(pulseSchedules.filePath, def.filePath))
      .get();

    if (existing) {
      this.db
        .update(pulseSchedules)
        .set({
          name: def.name,
          displayName: def.meta['display-name'] ?? null,
          description: def.meta.description ?? null,
          prompt: def.body,
          cron: def.meta.cron ?? '',
          timezone: def.meta.timezone,
          agentId: agentId ?? null,
          enabled: def.meta.enabled,
          maxRuntime: maxRuntimeMs,
          permissionMode: def.meta.permissions,
          tags: '[]',
          updatedAt: now,
        })
        .where(eq(pulseSchedules.id, existing.id))
        .run();
      return this.getTask(existing.id)!;
    }

    const id = ulid();
    this.db
      .insert(pulseSchedules)
      .values({
        id,
        name: def.name,
        displayName: def.meta['display-name'] ?? null,
        description: def.meta.description ?? null,
        prompt: def.body,
        cron: def.meta.cron ?? '',
        timezone: def.meta.timezone,
        agentId: agentId ?? null,
        enabled: def.meta.enabled,
        maxRuntime: maxRuntimeMs,
        permissionMode: def.meta.permissions,
        status: 'active',
        filePath: def.filePath,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.getTask(id)!;
  }

  /**
   * Mark a task as paused by its directory slug.
   *
   * Matches tasks whose `filePath` ends with `/{slug}/SKILL.md`.
   * Used when a task directory is removed from disk.
   *
   * @param slug - Kebab-case directory name
   * @returns The number of tasks marked as paused
   */
  markRemovedBySlug(slug: string): number {
    const now = new Date().toISOString();
    const result = this.db
      .update(pulseSchedules)
      .set({ enabled: false, status: 'paused', updatedAt: now })
      .where(like(pulseSchedules.filePath, `%/${slug}/${SKILL_FILENAME}`))
      .run();
    return result.changes;
  }

  /**
   * Find a task by its directory slug.
   *
   * Matches tasks whose `filePath` ends with `/{slug}/SKILL.md`.
   *
   * @param slug - Kebab-case directory name
   * @returns The matching Task or null
   */
  getBySlug(slug: string): Task | null {
    const row = this.db
      .select()
      .from(pulseSchedules)
      .where(like(pulseSchedules.filePath, `%/${slug}/${SKILL_FILENAME}`))
      .get();
    return row ? mapTaskRow(row) : null;
  }

  /** Close the database connection. No-op since the shared Db lifecycle is managed externally. */
  close(): void {
    logger.debug('TaskStore: close() called (no-op — db lifecycle managed externally)');
  }
}

/** Convert a Drizzle schedule row to a Task object. */
function mapTaskRow(row: typeof pulseSchedules.$inferSelect): Task {
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
    nextRun: null,
  } as Task;
}

/** Convert a Drizzle run row to a TaskRun object. */
function mapRunRow(row: typeof pulseRuns.$inferSelect): TaskRun {
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
