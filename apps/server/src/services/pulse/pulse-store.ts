import { eq, desc, and, count, notInArray } from 'drizzle-orm';
import { pulseSchedules, pulseRuns, type Db } from '@dorkos/db';
import { ulid } from 'ulidx';
import type {
  PulseSchedule,
  PulseRun,
  PulseRunStatus,
  PulseRunTrigger,
  CreateScheduleInput,
  UpdateScheduleRequest,
} from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';

/** Options for listing runs. */
interface ListRunsOptions {
  scheduleId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/** Fields that can be updated on a run. */
interface RunUpdate {
  status?: PulseRunStatus;
  finishedAt?: string;
  durationMs?: number;
  outputSummary?: string;
  error?: string;
  sessionId?: string;
}

/**
 * Persistence layer for Pulse scheduler data.
 *
 * Uses the shared Drizzle database for both schedule definitions and run history.
 * Replaces the former dual-backend approach (SQLite + JSON file).
 */
export class PulseStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // === Schedule CRUD ===

  /** Read all schedules from the database. */
  getSchedules(): PulseSchedule[] {
    const rows = this.db.select().from(pulseSchedules).all();
    return rows.map(mapScheduleRow);
  }

  /** Get a single schedule by ID. */
  getSchedule(id: string): PulseSchedule | null {
    const row = this.db
      .select()
      .from(pulseSchedules)
      .where(eq(pulseSchedules.id, id))
      .get();
    return row ? mapScheduleRow(row) : null;
  }

  /** Create a new schedule and persist to the database. */
  createSchedule(input: CreateScheduleInput): PulseSchedule {
    const now = new Date().toISOString();
    const id = ulid();

    this.db.insert(pulseSchedules).values({
      id,
      name: input.name,
      prompt: input.prompt,
      cron: input.cron,
      timezone: input.timezone ?? 'UTC',
      cwd: input.cwd ?? null,
      enabled: input.enabled ?? true,
      maxRuntime: input.maxRuntime ?? null,
      permissionMode: input.permissionMode ?? 'acceptEdits',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run();

    return this.getSchedule(id)!;
  }

  /** Update an existing schedule. Returns the updated schedule or null if not found. */
  updateSchedule(id: string, input: UpdateScheduleRequest): PulseSchedule | null {
    const existing = this.getSchedule(id);
    if (!existing) return null;

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (input.name !== undefined) updates.name = input.name;
    if (input.prompt !== undefined) updates.prompt = input.prompt;
    if (input.cron !== undefined) updates.cron = input.cron;
    if (input.timezone !== undefined) updates.timezone = input.timezone ?? 'UTC';
    if (input.cwd !== undefined) updates.cwd = input.cwd ?? null;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.maxRuntime !== undefined) updates.maxRuntime = input.maxRuntime ?? null;
    if (input.permissionMode !== undefined) updates.permissionMode = input.permissionMode;
    if (input.status !== undefined) updates.status = input.status;

    this.db
      .update(pulseSchedules)
      .set(updates)
      .where(eq(pulseSchedules.id, id))
      .run();

    return this.getSchedule(id);
  }

  /** Delete a schedule by ID. Returns true if found and deleted. */
  deleteSchedule(id: string): boolean {
    const result = this.db
      .delete(pulseSchedules)
      .where(eq(pulseSchedules.id, id))
      .run();
    return result.changes > 0;
  }

  // === Run CRUD ===

  /** Create a new run record. Returns the created run. */
  createRun(scheduleId: string, trigger: PulseRunTrigger): PulseRun {
    const id = ulid();
    const now = new Date().toISOString();

    this.db.insert(pulseRuns).values({
      id,
      scheduleId,
      status: 'running',
      startedAt: now,
      trigger,
      createdAt: now,
    }).run();

    return this.getRun(id)!;
  }

  /** Update fields on an existing run. Returns the updated run or null. */
  updateRun(id: string, update: RunUpdate): PulseRun | null {
    const existing = this.getRun(id);
    if (!existing) return null;

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
  getRun(id: string): PulseRun | null {
    const row = this.db
      .select()
      .from(pulseRuns)
      .where(eq(pulseRuns.id, id))
      .get();
    return row ? mapRunRow(row) : null;
  }

  /** List runs with optional schedule/status filter and pagination. */
  listRuns(opts: ListRunsOptions = {}): PulseRun[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const conditions = [];
    if (opts.scheduleId) {
      conditions.push(eq(pulseRuns.scheduleId, opts.scheduleId));
    }
    if (opts.status) {
      conditions.push(eq(pulseRuns.status, opts.status as typeof pulseRuns.status.enumValues[number]));
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
  getRunningRuns(): PulseRun[] {
    const rows = this.db
      .select()
      .from(pulseRuns)
      .where(eq(pulseRuns.status, 'running'))
      .all();
    return rows.map(mapRunRow);
  }

  /** Count total runs, optionally filtered by schedule. */
  countRuns(scheduleId?: string): number {
    if (scheduleId) {
      const result = this.db
        .select({ count: count() })
        .from(pulseRuns)
        .where(eq(pulseRuns.scheduleId, scheduleId))
        .get();
      return result?.count ?? 0;
    }
    const result = this.db
      .select({ count: count() })
      .from(pulseRuns)
      .get();
    return result?.count ?? 0;
  }

  /** Prune old runs, keeping only the most recent `retentionCount` per schedule. */
  pruneRuns(scheduleId: string, retentionCount: number): number {
    // Get the IDs to keep (most recent N runs for this schedule)
    const keepers = this.db
      .select({ id: pulseRuns.id })
      .from(pulseRuns)
      .where(eq(pulseRuns.scheduleId, scheduleId))
      .orderBy(desc(pulseRuns.createdAt))
      .limit(retentionCount)
      .all();

    const keeperIds = keepers.map((r) => r.id);

    if (keeperIds.length === 0) {
      // Delete all runs for this schedule
      const result = this.db
        .delete(pulseRuns)
        .where(eq(pulseRuns.scheduleId, scheduleId))
        .run();
      return result.changes;
    }

    // Delete runs not in the keeper list
    const result = this.db
      .delete(pulseRuns)
      .where(and(eq(pulseRuns.scheduleId, scheduleId), notInArray(pulseRuns.id, keeperIds)))
      .run();
    return result.changes;
  }

  /** Mark all currently running runs as failed (used on startup for crash recovery). */
  markRunningAsFailed(): number {
    const now = new Date().toISOString();
    const result = this.db
      .update(pulseRuns)
      .set({
        status: 'failed',
        finishedAt: now,
        error: 'Interrupted by server restart',
      })
      .where(eq(pulseRuns.status, 'running'))
      .run();
    return result.changes;
  }

  /** Close the database connection. No-op since the shared Db lifecycle is managed externally. */
  close(): void {
    logger.debug('PulseStore: close() called (no-op — db lifecycle managed externally)');
  }

}

/** Convert a Drizzle schedule row to a PulseSchedule object. */
function mapScheduleRow(row: typeof pulseSchedules.$inferSelect): PulseSchedule {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    cwd: row.cwd,
    enabled: row.enabled,
    maxRuntime: row.maxRuntime,
    permissionMode: row.permissionMode,
    status: row.status as PulseSchedule['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nextRun: null,
  } as PulseSchedule;
}

/** Convert a Drizzle run row to a PulseRun object. */
function mapRunRow(row: typeof pulseRuns.$inferSelect): PulseRun {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    status: row.status as PulseRunStatus,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    outputSummary: row.output,
    error: row.error,
    sessionId: row.sessionId,
    trigger: row.trigger as PulseRunTrigger,
    createdAt: row.createdAt,
  };
}
