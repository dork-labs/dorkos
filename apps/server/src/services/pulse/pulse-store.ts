import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type {
  PulseSchedule,
  PulseRun,
  PulseRunStatus,
  PulseRunTrigger,
  CreateScheduleInput,
  UpdateScheduleRequest,
} from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';

/** Raw row shape from the `runs` SQLite table (snake_case). */
interface RunRow {
  id: string;
  schedule_id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  output_summary: string | null;
  error: string | null;
  session_id: string | null;
  trigger: string;
  created_at: string;
}

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

/** Persisted schedule shape in schedules.json (matches PulseSchedule minus nextRun). */
interface StoredSchedule {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string | null;
  cwd: string | null;
  enabled: boolean;
  maxRuntime: number | null;
  permissionMode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const MIGRATIONS = [
  // Version 1: initial schema
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    output_summary TEXT,
    error TEXT,
    session_id TEXT,
    trigger TEXT NOT NULL DEFAULT 'scheduled',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_schedule_id ON runs(schedule_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);`,
];

/**
 * Persistence layer for Pulse scheduler data.
 *
 * Manages two storage backends:
 * - SQLite (`~/.dork/pulse.db`) for run history with WAL mode
 * - JSON (`~/.dork/schedules.json`) for schedule definitions with atomic writes
 */
export class PulseStore {
  private db: Database.Database;
  private schedulesPath: string;
  private stmts: {
    insertRun: Database.Statement;
    updateRun: Database.Statement;
    getRun: Database.Statement;
    listRuns: Database.Statement;
    listRunsBySchedule: Database.Statement;
    getRunningRuns: Database.Statement;
    countRuns: Database.Statement;
    countRunsBySchedule: Database.Statement;
    deleteRunsBySchedule: Database.Statement;
  };

  constructor(dorkHome?: string) {
    const home = dorkHome ?? env.DORK_HOME ?? path.join(os.homedir(), '.dork');
    fs.mkdirSync(home, { recursive: true });

    const dbPath = path.join(home, 'pulse.db');
    this.schedulesPath = path.join(home, 'schedules.json');

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    this.runMigrations();

    this.stmts = {
      insertRun: this.db.prepare(
        `INSERT INTO runs (id, schedule_id, status, started_at, trigger, created_at)
         VALUES (?, ?, 'running', ?, ?, ?)`
      ),
      updateRun: this.db.prepare(
        `UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?,
         output_summary = ?, error = ?, session_id = ? WHERE id = ?`
      ),
      getRun: this.db.prepare('SELECT * FROM runs WHERE id = ?'),
      listRuns: this.db.prepare(
        'SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ),
      listRunsBySchedule: this.db.prepare(
        'SELECT * FROM runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ),
      getRunningRuns: this.db.prepare("SELECT * FROM runs WHERE status = 'running'"),
      countRuns: this.db.prepare('SELECT COUNT(*) as count FROM runs'),
      countRunsBySchedule: this.db.prepare(
        'SELECT COUNT(*) as count FROM runs WHERE schedule_id = ?'
      ),
      deleteRunsBySchedule: this.db.prepare(
        `DELETE FROM runs WHERE schedule_id = ? AND id NOT IN (
          SELECT id FROM runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ?
        )`
      ),
    };
  }

  // === Schedule CRUD (JSON file) ===

  /** Read all schedules from the JSON file. */
  getSchedules(): PulseSchedule[] {
    const data = this.readSchedulesFile();
    return data.map((s) => ({ ...s, nextRun: null }) as PulseSchedule);
  }

  /** Get a single schedule by ID. */
  getSchedule(id: string): PulseSchedule | null {
    const schedules = this.readSchedulesFile();
    const found = schedules.find((s) => s.id === id);
    if (!found) return null;
    return { ...found, nextRun: null } as PulseSchedule;
  }

  /** Create a new schedule and persist to disk. */
  createSchedule(input: CreateScheduleInput): PulseSchedule {
    const now = new Date().toISOString();
    const schedule: StoredSchedule = {
      id: crypto.randomUUID(),
      name: input.name,
      prompt: input.prompt,
      cron: input.cron,
      timezone: input.timezone ?? null,
      cwd: input.cwd ?? null,
      enabled: input.enabled ?? true,
      maxRuntime: input.maxRuntime ?? null,
      permissionMode: input.permissionMode ?? 'acceptEdits',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    const schedules = this.readSchedulesFile();
    schedules.push(schedule);
    this.writeSchedulesFile(schedules);

    return { ...schedule, nextRun: null } as PulseSchedule;
  }

  /** Update an existing schedule. Returns the updated schedule or null if not found. */
  updateSchedule(id: string, input: UpdateScheduleRequest): PulseSchedule | null {
    const schedules = this.readSchedulesFile();
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx === -1) return null;

    const existing = schedules[idx];
    const updated: StoredSchedule = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.prompt !== undefined && { prompt: input.prompt }),
      ...(input.cron !== undefined && { cron: input.cron }),
      ...(input.timezone !== undefined && { timezone: input.timezone ?? null }),
      ...(input.cwd !== undefined && { cwd: input.cwd ?? null }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.maxRuntime !== undefined && { maxRuntime: input.maxRuntime ?? null }),
      ...(input.permissionMode !== undefined && { permissionMode: input.permissionMode }),
      ...(input.status !== undefined && { status: input.status }),
      updatedAt: new Date().toISOString(),
    };

    schedules[idx] = updated;
    this.writeSchedulesFile(schedules);

    return { ...updated, nextRun: null } as PulseSchedule;
  }

  /** Delete a schedule by ID. Returns true if found and deleted. */
  deleteSchedule(id: string): boolean {
    const schedules = this.readSchedulesFile();
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx === -1) return false;

    schedules.splice(idx, 1);
    this.writeSchedulesFile(schedules);
    return true;
  }

  // === Run CRUD (SQLite) ===

  /** Create a new run record. Returns the created run. */
  createRun(scheduleId: string, trigger: PulseRunTrigger): PulseRun {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.stmts.insertRun.run(id, scheduleId, now, trigger, now);
    return this.getRun(id)!;
  }

  /** Update fields on an existing run. Returns the updated run or null. */
  updateRun(id: string, update: RunUpdate): PulseRun | null {
    const existing = this.getRun(id);
    if (!existing) return null;

    this.stmts.updateRun.run(
      update.status ?? existing.status,
      update.finishedAt ?? existing.finishedAt,
      update.durationMs ?? existing.durationMs,
      update.outputSummary ?? existing.outputSummary,
      update.error ?? existing.error,
      update.sessionId ?? existing.sessionId,
      id
    );

    return this.getRun(id);
  }

  /** Get a single run by ID. */
  getRun(id: string): PulseRun | null {
    const row = this.stmts.getRun.get(id) as RunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  /** List runs with optional schedule/status filter and pagination. */
  listRuns(opts: ListRunsOptions = {}): PulseRun[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.scheduleId) {
      conditions.push('schedule_id = ?');
      params.push(opts.scheduleId);
    }
    if (opts.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as RunRow[];
    return rows.map(mapRunRow);
  }

  /** Get all currently running runs. */
  getRunningRuns(): PulseRun[] {
    const rows = this.stmts.getRunningRuns.all() as RunRow[];
    return rows.map(mapRunRow);
  }

  /** Count total runs, optionally filtered by schedule. */
  countRuns(scheduleId?: string): number {
    if (scheduleId) {
      const result = this.stmts.countRunsBySchedule.get(scheduleId) as { count: number };
      return result.count;
    }
    const result = this.stmts.countRuns.get() as { count: number };
    return result.count;
  }

  /** Prune old runs, keeping only the most recent `retentionCount` per schedule. */
  pruneRuns(scheduleId: string, retentionCount: number): number {
    const result = this.stmts.deleteRunsBySchedule.run(scheduleId, scheduleId, retentionCount);
    return result.changes;
  }

  /** Mark all currently running runs as failed (used on startup for crash recovery). */
  markRunningAsFailed(): number {
    const stmt = this.db.prepare(
      `UPDATE runs SET status = 'failed', finished_at = ?, error = 'Interrupted by server restart'
       WHERE status = 'running'`
    );
    const result = stmt.run(new Date().toISOString());
    return result.changes;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
    logger.debug('PulseStore: database closed');
  }

  // === Internal helpers ===

  private runMigrations(): void {
    const currentVersion = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (currentVersion >= MIGRATIONS.length) return;

    const migrate = this.db.transaction(() => {
      for (let i = currentVersion; i < MIGRATIONS.length; i++) {
        this.db.exec(MIGRATIONS[i]);
        logger.debug(`PulseStore: applied migration ${i + 1}`);
      }
      this.db.pragma(`user_version = ${MIGRATIONS.length}`);
    });

    migrate();
  }

  private readSchedulesFile(): StoredSchedule[] {
    try {
      const content = fs.readFileSync(this.schedulesPath, 'utf-8');
      return JSON.parse(content) as StoredSchedule[];
    } catch {
      return [];
    }
  }

  private writeSchedulesFile(schedules: StoredSchedule[]): void {
    const tmpPath = `${this.schedulesPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(schedules, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.schedulesPath);
  }
}

/** Convert a snake_case SQLite row to a camelCase PulseRun object. */
function mapRunRow(row: RunRow): PulseRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    status: row.status as PulseRunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    outputSummary: row.output_summary,
    error: row.error,
    sessionId: row.session_id,
    trigger: row.trigger as PulseRunTrigger,
    createdAt: row.created_at,
  };
}
