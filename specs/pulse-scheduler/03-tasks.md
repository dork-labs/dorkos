# Task Breakdown: DorkOS Pulse (Scheduler)

Generated: 2026-02-18
Source: specs/pulse-scheduler/02-specification.md
Last Decompose: 2026-02-18

## Overview

DorkOS Pulse is the autonomous scheduler that runs Claude Agent SDK prompts on cron schedules. It adds PulseStore (SQLite + JSON persistence), SchedulerService (croner-based dispatch), 5 MCP tools, 8 REST endpoints, and a full client UI with FSD architecture. Jobs are defined in `~/.dork/schedules.json`, run history in `~/.dork/pulse.db`, and run transcripts are SDK JSONL files viewed through the existing chat UI.

## Phase 1: Foundation

### Task 1.1: Install Dependencies and Add Shared Schemas

**Description**: Install npm packages and add all Pulse Zod schemas to packages/shared/src/
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None (foundation for everything)

**Technical Requirements**:

- Install `better-sqlite3@^11.x`, `@types/better-sqlite3@^7.x`, `croner@^9.x` in `apps/server`
- Install `cronstrue@^2.x` in `apps/client`
- Add `scheduler` section to `UserConfigSchema` in `packages/shared/src/config-schema.ts`
- Add Pulse schemas to `packages/shared/src/schemas.ts`
- Re-export new types from `packages/shared/src/types.ts`

**Implementation Steps**:

1. Install server dependencies:

```bash
npm install better-sqlite3 croner -w apps/server
npm install -D @types/better-sqlite3 -w apps/server
```

2. Install client dependency:

```bash
npm install cronstrue -w apps/client
```

3. Add scheduler config to `packages/shared/src/config-schema.ts` inside `UserConfigSchema`:

```typescript
scheduler: z
  .object({
    enabled: z.boolean().default(false),
    maxConcurrentRuns: z.number().int().min(1).max(10).default(1),
    timezone: z.string().nullable().default(null),
    retentionCount: z.number().int().min(1).default(100),
  })
  .default(() => ({
    enabled: false,
    maxConcurrentRuns: 1,
    timezone: null,
    retentionCount: 100,
  })),
```

4. Add Pulse schemas to `packages/shared/src/schemas.ts`:

```typescript
// === Pulse Enums ===

export const PulseScheduleStatusSchema = z
  .enum(['active', 'paused', 'pending_approval'])
  .openapi('PulseScheduleStatus');
export type PulseScheduleStatus = z.infer<typeof PulseScheduleStatusSchema>;

export const PulseRunStatusSchema = z
  .enum(['running', 'completed', 'failed', 'cancelled'])
  .openapi('PulseRunStatus');
export type PulseRunStatus = z.infer<typeof PulseRunStatusSchema>;

export const PulseRunTriggerSchema = z.enum(['scheduled', 'manual']).openapi('PulseRunTrigger');
export type PulseRunTrigger = z.infer<typeof PulseRunTriggerSchema>;

// === Pulse Schedule ===

export const PulseScheduleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100),
    prompt: z.string().min(1),
    cron: z.string().min(1),
    timezone: z.string().default('UTC'),
    cwd: z.string().min(1),
    enabled: z.boolean().default(true),
    maxRuntime: z.number().int().min(1000).default(600000),
    permissionMode: z.enum(['acceptEdits', 'bypassPermissions']).default('acceptEdits'),
    status: PulseScheduleStatusSchema.default('active'),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    nextRun: z.string().datetime().nullable().optional(),
  })
  .openapi('PulseSchedule');
export type PulseSchedule = z.infer<typeof PulseScheduleSchema>;

// === Pulse Run ===

export const PulseRunSchema = z
  .object({
    id: z.string().uuid(),
    scheduleId: z.string().uuid(),
    status: PulseRunStatusSchema.default('running'),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    durationMs: z.number().int().nullable(),
    outputSummary: z.string().nullable(),
    error: z.string().nullable(),
    sessionId: z.string().nullable(),
    trigger: PulseRunTriggerSchema.default('scheduled'),
    createdAt: z.string().datetime(),
  })
  .openapi('PulseRun');
export type PulseRun = z.infer<typeof PulseRunSchema>;

// === Request Schemas ===

export const CreateScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(100),
    prompt: z.string().min(1),
    cron: z.string().min(1),
    cwd: z.string().min(1),
    timezone: z.string().optional(),
    maxRuntime: z.number().int().min(1000).optional(),
    permissionMode: z.enum(['acceptEdits', 'bypassPermissions']).optional(),
  })
  .openapi('CreateScheduleRequest');
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export const UpdateScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    prompt: z.string().min(1).optional(),
    cron: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    timezone: z.string().optional(),
    enabled: z.boolean().optional(),
    maxRuntime: z.number().int().min(1000).optional(),
    permissionMode: z.enum(['acceptEdits', 'bypassPermissions']).optional(),
    status: PulseScheduleStatusSchema.optional(),
  })
  .openapi('UpdateScheduleRequest');
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequestSchema>;

export const ListRunsQuerySchema = z
  .object({
    schedule_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('ListRunsQuery');
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;
```

5. Add re-exports to `packages/shared/src/types.ts`:

```typescript
export type {
  PulseSchedule,
  PulseScheduleStatus,
  PulseRun,
  PulseRunStatus,
  PulseRunTrigger,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  ListRunsQuery,
} from './schemas.js';
```

**Acceptance Criteria**:

- [ ] `better-sqlite3`, `croner` installed in server; `cronstrue` in client
- [ ] `UserConfigSchema` includes `scheduler` section with correct defaults
- [ ] `USER_CONFIG_DEFAULTS` parses successfully with new scheduler section
- [ ] All Pulse schemas defined with OpenAPI metadata
- [ ] Types re-exported from `types.ts`
- [ ] `npm run typecheck` passes across all packages

---

### Task 1.2: Implement PulseStore Service

**Description**: Create the data persistence layer managing SQLite run records and JSON schedule files
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None (foundation for scheduler service)

**Technical Requirements**:

- File: `apps/server/src/services/pulse-store.ts`
- Manages `~/.dork/schedules.json` (atomic write via temp + rename)
- Manages `~/.dork/pulse.db` (SQLite with WAL mode)
- Singleton pattern consistent with other services
- Prepared statements for all hot queries

**Implementation Steps**:

1. Create `apps/server/src/services/pulse-store.ts` with the following class:

```typescript
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  PulseSchedule,
  PulseRun,
  CreateScheduleRequest,
  UpdateScheduleRequest,
} from '@dorkos/shared/types';

const MIGRATIONS: string[] = [
  // v1: Initial schema
  `CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    schedule_id   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'running',
    started_at    TEXT,
    finished_at   TEXT,
    duration_ms   INTEGER,
    output_summary TEXT,
    error         TEXT,
    session_id    TEXT,
    trigger       TEXT NOT NULL DEFAULT 'scheduled',
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_schedule_id ON runs(schedule_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);`,
];

export class PulseStore {
  private db: Database.Database;
  private schedulesPath: string;
  private stmts!: {
    insertRun: Database.Statement;
    updateRun: Database.Statement;
    getRun: Database.Statement;
    listRuns: Database.Statement;
    listRunsBySchedule: Database.Statement;
    getRunningRuns: Database.Statement;
    countRuns: Database.Statement;
    countRunsBySchedule: Database.Statement;
    pruneRuns: Database.Statement;
  };

  constructor(dorkHome: string) {
    this.schedulesPath = path.join(dorkHome, 'schedules.json');
    const dbPath = path.join(dorkHome, 'pulse.db');
    fs.mkdirSync(dorkHome, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    this.migrate();
    this.prepareStatements();
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]);
    }
    this.db.pragma(`user_version = ${MIGRATIONS.length}`);
  }

  private prepareStatements(): void {
    this.stmts = {
      insertRun: this.db.prepare(
        "INSERT INTO runs (id, schedule_id, status, started_at, trigger, created_at) VALUES (?, ?, 'running', ?, ?, ?)"
      ),
      updateRun: this.db.prepare(
        'UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, output_summary = ?, error = ?, session_id = ? WHERE id = ?'
      ),
      getRun: this.db.prepare('SELECT * FROM runs WHERE id = ?'),
      listRuns: this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?'),
      listRunsBySchedule: this.db.prepare(
        'SELECT * FROM runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ),
      getRunningRuns: this.db.prepare("SELECT * FROM runs WHERE status = 'running'"),
      countRuns: this.db.prepare('SELECT COUNT(*) as count FROM runs'),
      countRunsBySchedule: this.db.prepare(
        'SELECT COUNT(*) as count FROM runs WHERE schedule_id = ?'
      ),
      pruneRuns: this.db.prepare(
        'DELETE FROM runs WHERE id IN (SELECT id FROM runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?)'
      ),
    };
  }

  // Schedule CRUD (JSON file)

  getSchedules(): PulseSchedule[] {
    try {
      const data = fs.readFileSync(this.schedulesPath, 'utf-8');
      return JSON.parse(data) as PulseSchedule[];
    } catch {
      return [];
    }
  }

  getSchedule(id: string): PulseSchedule | undefined {
    return this.getSchedules().find((s) => s.id === id);
  }

  createSchedule(input: CreateScheduleRequest & { status?: string }): PulseSchedule {
    const schedules = this.getSchedules();
    const now = new Date().toISOString();
    const schedule: PulseSchedule = {
      id: randomUUID(),
      name: input.name,
      prompt: input.prompt,
      cron: input.cron,
      cwd: input.cwd,
      timezone: input.timezone ?? 'UTC',
      enabled: true,
      maxRuntime: input.maxRuntime ?? 600000,
      permissionMode: input.permissionMode ?? 'acceptEdits',
      status: (input.status as PulseSchedule['status']) ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    schedules.push(schedule);
    this.writeSchedules(schedules);
    return schedule;
  }

  updateSchedule(id: string, input: UpdateScheduleRequest): PulseSchedule {
    const schedules = this.getSchedules();
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Schedule not found: ${id}`);
    const updated = { ...schedules[idx], ...input, updatedAt: new Date().toISOString() };
    schedules[idx] = updated;
    this.writeSchedules(schedules);
    return updated;
  }

  deleteSchedule(id: string): void {
    const schedules = this.getSchedules().filter((s) => s.id !== id);
    this.writeSchedules(schedules);
  }

  private writeSchedules(schedules: PulseSchedule[]): void {
    const tmpPath = this.schedulesPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(schedules, null, 2));
    fs.renameSync(tmpPath, this.schedulesPath);
  }

  // Run CRUD (SQLite)

  createRun(scheduleId: string, trigger: 'scheduled' | 'manual'): PulseRun {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.stmts.insertRun.run(id, scheduleId, now, trigger, now);
    return this.getRun(id)!;
  }

  updateRun(id: string, update: Partial<PulseRun>): void {
    const existing = this.getRun(id);
    if (!existing) throw new Error(`Run not found: ${id}`);
    this.stmts.updateRun.run(
      update.status ?? existing.status,
      update.finishedAt ?? existing.finishedAt,
      update.durationMs ?? existing.durationMs,
      update.outputSummary ?? existing.outputSummary,
      update.error ?? existing.error,
      update.sessionId ?? existing.sessionId,
      id
    );
  }

  getRun(id: string): PulseRun | undefined {
    const row = this.stmts.getRun.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRunRow(row) : undefined;
  }

  listRuns(opts?: { scheduleId?: string; limit?: number; offset?: number }): PulseRun[] {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const rows = opts?.scheduleId
      ? (this.stmts.listRunsBySchedule.all(opts.scheduleId, limit, offset) as Record<
          string,
          unknown
        >[])
      : (this.stmts.listRuns.all(limit, offset) as Record<string, unknown>[]);
    return rows.map((r) => this.mapRunRow(r));
  }

  getRunningRuns(): PulseRun[] {
    return (this.stmts.getRunningRuns.all() as Record<string, unknown>[]).map((r) =>
      this.mapRunRow(r)
    );
  }

  countRuns(scheduleId?: string): number {
    if (scheduleId) {
      return (this.stmts.countRunsBySchedule.get(scheduleId) as { count: number }).count;
    }
    return (this.stmts.countRuns.get() as { count: number }).count;
  }

  pruneRuns(retentionCount: number): number {
    const schedules = this.getSchedules();
    let pruned = 0;
    for (const s of schedules) {
      const result = this.stmts.pruneRuns.run(s.id, retentionCount);
      pruned += result.changes;
    }
    return pruned;
  }

  close(): void {
    this.db.close();
  }

  private mapRunRow(row: Record<string, unknown>): PulseRun {
    return {
      id: row.id as string,
      scheduleId: row.schedule_id as string,
      status: row.status as PulseRun['status'],
      startedAt: (row.started_at as string) ?? null,
      finishedAt: (row.finished_at as string) ?? null,
      durationMs: (row.duration_ms as number) ?? null,
      outputSummary: (row.output_summary as string) ?? null,
      error: (row.error as string) ?? null,
      sessionId: (row.session_id as string) ?? null,
      trigger: row.trigger as PulseRun['trigger'],
      createdAt: row.created_at as string,
    };
  }
}
```

2. Write unit tests in `apps/server/src/services/__tests__/pulse-store.test.ts`:
   - Schedule CRUD: create, read, update, delete on JSON file
   - Run CRUD: create, update, query, count in SQLite (use temp dir for both)
   - Atomic write: verify .tmp rename pattern
   - Run retention pruning: verify only last N kept per schedule
   - Schema migration: runs idempotently
   - Missing/corrupt file graceful handling on startup

**Acceptance Criteria**:

- [ ] `PulseStore` class created at `apps/server/src/services/pulse-store.ts`
- [ ] Schedule CRUD reads/writes `~/.dork/schedules.json` with atomic rename
- [ ] SQLite database created at `~/.dork/pulse.db` with WAL mode
- [ ] Prepared statements for all queries
- [ ] `mapRunRow` converts snake_case DB columns to camelCase TypeScript
- [ ] All unit tests pass (CRUD, pruning, migration, error handling)

---

### Task 1.3: Implement SchedulerService

**Description**: Create the cron orchestration service that manages job lifecycle and dispatches agent runs
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: None

**Technical Requirements**:

- File: `apps/server/src/services/scheduler-service.ts`
- Uses `croner` for cron scheduling with `protect: true` (skip overlapping)
- Manages `activeRuns` Map of run ID to AbortController
- Dispatches to `AgentManager.sendMessage()` with system prompt injection
- Graceful shutdown with 30s timeout

**Implementation Steps**:

1. Create `apps/server/src/services/scheduler-service.ts`:

```typescript
import { Cron } from 'croner';
import type { PulseStore } from './pulse-store.js';
import type { AgentManager } from './agent-manager.js';
import type { PulseSchedule, PulseRun } from '@dorkos/shared/types';
import { logger } from '../lib/logger.js';

export interface SchedulerConfig {
  maxConcurrentRuns: number;
  timezone?: string;
  retentionCount: number;
}

export class SchedulerService {
  private cronJobs = new Map<string, Cron>();
  private activeRuns = new Map<string, AbortController>();
  private store: PulseStore;
  private agentManager: AgentManager;
  private config: SchedulerConfig;

  constructor(store: PulseStore, agentManager: AgentManager, config: SchedulerConfig) {
    this.store = store;
    this.agentManager = agentManager;
    this.config = config;
  }

  start(): void {
    // Mark interrupted runs as failed
    const runningRuns = this.store.getRunningRuns();
    for (const run of runningRuns) {
      this.store.updateRun(run.id, {
        status: 'failed',
        error: 'Interrupted by server restart',
        finishedAt: new Date().toISOString(),
      });
    }

    // Prune old runs
    this.store.pruneRuns(this.config.retentionCount);

    // Register enabled+active schedules
    const schedules = this.store.getSchedules();
    for (const schedule of schedules) {
      if (schedule.enabled && schedule.status === 'active') {
        this.registerSchedule(schedule);
      }
    }

    logger.info(`[Pulse] Started with ${this.cronJobs.size} active schedules`);
  }

  async stop(): Promise<void> {
    // Stop all cron jobs
    for (const [id, job] of this.cronJobs) {
      job.stop();
      this.cronJobs.delete(id);
    }

    // Abort all active runs
    for (const [, controller] of this.activeRuns) {
      controller.abort();
    }

    // Wait up to 30s for active runs to complete
    const deadline = Date.now() + 30_000;
    while (this.activeRuns.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    this.store.close();
    logger.info('[Pulse] Scheduler stopped');
  }

  registerSchedule(schedule: PulseSchedule): void {
    this.unregisterSchedule(schedule.id);
    const tz = schedule.timezone || this.config.timezone || undefined;
    const job = new Cron(schedule.cron, { timezone: tz, protect: true }, () => {
      void this.dispatch(schedule);
    });
    this.cronJobs.set(schedule.id, job);
  }

  unregisterSchedule(id: string): void {
    const existing = this.cronJobs.get(id);
    if (existing) {
      existing.stop();
      this.cronJobs.delete(id);
    }
  }

  async triggerManualRun(scheduleId: string): Promise<string> {
    const schedule = this.store.getSchedule(scheduleId);
    if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
    const run = this.store.createRun(scheduleId, 'manual');
    void this.executeRun(schedule, run);
    return run.id;
  }

  cancelRun(runId: string): void {
    const controller = this.activeRuns.get(runId);
    if (!controller) throw new Error(`No active run: ${runId}`);
    controller.abort();
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  private async dispatch(schedule: PulseSchedule): Promise<void> {
    if (this.activeRuns.size >= this.config.maxConcurrentRuns) {
      logger.warn(
        `[Pulse] Skipping "${schedule.name}" - concurrency limit (${this.activeRuns.size}/${this.config.maxConcurrentRuns})`
      );
      return;
    }

    const current = this.store.getSchedule(schedule.id);
    if (!current || !current.enabled || current.status !== 'active') return;

    const run = this.store.createRun(schedule.id, 'scheduled');
    await this.executeRun(current, run);
  }

  private async executeRun(schedule: PulseSchedule, run: PulseRun): Promise<void> {
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(schedule.maxRuntime);
    const combinedSignal = AbortSignal.any([controller.signal, timeoutSignal]);

    this.activeRuns.set(run.id, controller);
    let outputSummary = '';

    try {
      const append = buildPulseAppend(schedule, run);

      const generator = this.agentManager.sendMessage({
        sessionId: run.id,
        content: schedule.prompt,
        cwd: schedule.cwd,
        permissionMode: schedule.permissionMode,
        systemPromptAppend: append,
        signal: combinedSignal,
      });

      for await (const event of generator) {
        if (event.type === 'text_delta' && event.text) {
          if (outputSummary.length < 500) {
            outputSummary += event.text;
          }
        }
        if (event.type === 'done') {
          const sessionId = event.sessionId ?? null;
          this.store.updateRun(run.id, {
            status: 'completed',
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - new Date(run.startedAt!).getTime(),
            outputSummary: outputSummary.slice(0, 500) || null,
            sessionId,
          });
        }
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      this.store.updateRun(run.id, {
        status: isAbort ? 'cancelled' : 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(run.startedAt!).getTime(),
        error: isAbort ? 'Run cancelled' : err instanceof Error ? err.message : String(err),
        outputSummary: outputSummary.slice(0, 500) || null,
      });
    } finally {
      this.activeRuns.delete(run.id);
    }
  }
}

/** @internal Exported for testing only. */
export function buildPulseAppend(schedule: PulseSchedule, run: PulseRun): string {
  return [
    '---',
    '## PULSE SCHEDULER CONTEXT',
    '',
    'You are running as a scheduled agent in DorkOS Pulse.',
    '',
    `- Job: "${schedule.name}"`,
    `- Schedule: ${schedule.cron} (${schedule.timezone})`,
    `- Working Directory: ${schedule.cwd}`,
    `- Run ID: ${run.id}`,
    `- Trigger: ${run.trigger}`,
    '',
    'You are running UNATTENDED. Do not wait for user input.',
    'Make conservative decisions. Report findings clearly.',
    'You have access to schedule management tools (mcp__dorkos__*).',
    '---',
  ].join('\n');
}
```

2. Write unit tests in `apps/server/src/services/__tests__/scheduler-service.test.ts`:
   - Registers cron jobs for enabled+active schedules on `start()`
   - Dispatches job when croner callback fires (mock croner)
   - Respects global concurrency cap (skips when at limit)
   - Skips disabled/paused schedules
   - Timeout via AbortController sets run status to `cancelled`
   - Agent error sets run status to `failed` with error message
   - Marks interrupted `running` runs as `failed` on startup
   - Graceful shutdown aborts active runs and waits up to 30s
   - Manual trigger creates run with `trigger: 'manual'`
   - `cancelRun` aborts the correct controller
   - `buildPulseAppend` produces correct system prompt

**Acceptance Criteria**:

- [ ] `SchedulerService` created at `apps/server/src/services/scheduler-service.ts`
- [ ] Croner jobs registered with `protect: true` for overlap protection
- [ ] Concurrency cap enforced (default 1)
- [ ] AbortController + AbortSignal.timeout for run cancellation
- [ ] `buildPulseAppend` generates correct system prompt context
- [ ] All unit tests pass (mock croner, mock AgentManager)

---

## Phase 2: Interfaces

### Task 2.1: Add MCP Pulse Tools

**Description**: Add 5 schedule management tools to the existing MCP tool server
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Extend `McpToolDeps` with optional `pulseStore`
- Add 5 tools: `list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule`, `get_run_history`
- `create_schedule` always sets `status: 'pending_approval'`
- All tools return error when `pulseStore` is undefined

**Implementation Steps**:

1. Update `McpToolDeps` in `apps/server/src/services/mcp-tool-server.ts`:

```typescript
import type { PulseStore } from './pulse-store.js';

export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  defaultCwd: string;
  pulseStore?: PulseStore;
}
```

2. Add tool handler factory:

```typescript
function createPulseToolHandlers(deps: McpToolDeps) {
  const requireStore = () => {
    if (!deps.pulseStore) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Pulse scheduler is not enabled. Enable it in settings or with --pulse flag.',
            }),
          },
        ],
        isError: true,
      };
    }
    return null;
  };

  const handleListSchedules = async (args: { enabled_only?: boolean }) => {
    const err = requireStore();
    if (err) return err;
    const schedules = deps.pulseStore!.getSchedules();
    const filtered = args.enabled_only ? schedules.filter((s) => s.enabled) : schedules;
    return { content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }] };
  };

  const handleCreateSchedule = async (args: {
    name: string;
    prompt: string;
    cron: string;
    cwd?: string;
    timezone?: string;
    maxRuntime?: number;
    permissionMode?: string;
  }) => {
    const err = requireStore();
    if (err) return err;
    const schedule = deps.pulseStore!.createSchedule({
      name: args.name,
      prompt: args.prompt,
      cron: args.cron,
      cwd: args.cwd ?? deps.defaultCwd,
      timezone: args.timezone,
      maxRuntime: args.maxRuntime,
      permissionMode: args.permissionMode as 'acceptEdits' | 'bypassPermissions' | undefined,
      status: 'pending_approval',
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(schedule, null, 2) }] };
  };

  const handleUpdateSchedule = async (args: { id: string; [key: string]: unknown }) => {
    const err = requireStore();
    if (err) return err;
    try {
      const { id, ...update } = args;
      const schedule = deps.pulseStore!.updateSchedule(id, update);
      return { content: [{ type: 'text' as const, text: JSON.stringify(schedule, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      };
    }
  };

  const handleDeleteSchedule = async (args: { id: string }) => {
    const err = requireStore();
    if (err) return err;
    deps.pulseStore!.deleteSchedule(args.id);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, message: `Schedule ${args.id} deleted` }),
        },
      ],
    };
  };

  const handleGetRunHistory = async (args: { schedule_id: string; limit?: number }) => {
    const err = requireStore();
    if (err) return err;
    const runs = deps.pulseStore!.listRuns({
      scheduleId: args.schedule_id,
      limit: args.limit ?? 10,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(runs, null, 2) }] };
  };

  return {
    handleListSchedules,
    handleCreateSchedule,
    handleUpdateSchedule,
    handleDeleteSchedule,
    handleGetRunHistory,
  };
}
```

3. Register tools in `createDorkOsToolServer` tools array:

```typescript
const pulseHandlers = createPulseToolHandlers(deps);
// Add to tools array:
tool('list_schedules', 'List all Pulse scheduled jobs', {
  enabled_only: z.boolean().optional().describe('Only return enabled schedules'),
}, pulseHandlers.handleListSchedules),
tool('create_schedule', 'Create a new Pulse scheduled job (requires user approval)', {
  name: z.string().describe('Human-readable job name'),
  prompt: z.string().describe('Agent prompt/instructions'),
  cron: z.string().describe('5-field cron expression'),
  cwd: z.string().optional().describe('Working directory'),
  timezone: z.string().optional().describe('IANA timezone'),
  maxRuntime: z.number().optional().describe('Timeout in ms'),
  permissionMode: z.enum(['acceptEdits', 'bypassPermissions']).optional(),
}, pulseHandlers.handleCreateSchedule),
tool('update_schedule', 'Update an existing Pulse schedule', {
  id: z.string().describe('Schedule UUID'),
  name: z.string().optional(), prompt: z.string().optional(),
  cron: z.string().optional(), enabled: z.boolean().optional(),
  timezone: z.string().optional(), maxRuntime: z.number().optional(),
  permissionMode: z.enum(['acceptEdits', 'bypassPermissions']).optional(),
}, pulseHandlers.handleUpdateSchedule),
tool('delete_schedule', 'Delete a Pulse schedule', {
  id: z.string().describe('Schedule UUID'),
}, pulseHandlers.handleDeleteSchedule),
tool('get_run_history', 'Get run history for a Pulse schedule', {
  schedule_id: z.string().describe('Schedule UUID'),
  limit: z.number().optional().describe('Max results (default 10)'),
}, pulseHandlers.handleGetRunHistory),
```

4. Extend tests in `apps/server/src/services/__tests__/mcp-tool-server.test.ts`:
   - `create_schedule` creates with `pending_approval` status
   - `list_schedules` with `enabled_only` filter
   - `update_schedule` validates schedule exists, returns error if not
   - `delete_schedule` removes schedule
   - `get_run_history` returns runs in reverse chronological order
   - All tools return error when `pulseStore` is undefined

**Acceptance Criteria**:

- [ ] `McpToolDeps` extended with optional `pulseStore`
- [ ] 5 MCP tools registered in tool server
- [ ] `create_schedule` always sets `status: 'pending_approval'`
- [ ] All tools return clear error when Pulse is disabled
- [ ] Tests pass for all 5 tools + disabled state

---

### Task 2.2: Create REST Routes for Pulse

**Description**: Create the /api/pulse/\* route group with 8 endpoints
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2, Task 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- File: `apps/server/src/routes/pulse.ts`
- Follows existing route patterns (Zod validation, delegate to service, consistent errors)
- `GET /schedules` computes `nextRun` via croner `nextRun()`
- All schedule `cwd` fields validated against directory boundary

**Implementation Steps**:

1. Create `apps/server/src/routes/pulse.ts`:

```typescript
import { Router, type Request, type Response } from 'express';
import { Cron } from 'croner';
import {
  CreateScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  ListRunsQuerySchema,
} from '@dorkos/shared/schemas';
import type { PulseStore } from '../services/pulse-store.js';
import type { SchedulerService } from '../services/scheduler-service.js';
import { isWithinBoundary } from '../lib/boundary.js';

export function createPulseRouter(store: PulseStore, scheduler: SchedulerService): Router {
  const router = Router();

  // GET /api/pulse/schedules - List all schedules with computed nextRun
  router.get('/schedules', (_req: Request, res: Response) => {
    const schedules = store.getSchedules().map((s) => {
      let nextRun: string | null = null;
      try {
        if (s.enabled && s.status === 'active') {
          const cron = new Cron(s.cron, { timezone: s.timezone || undefined });
          const next = cron.nextRun();
          nextRun = next ? next.toISOString() : null;
          cron.stop();
        }
      } catch {
        /* invalid cron */
      }
      return { ...s, nextRun };
    });
    res.json(schedules);
  });

  // POST /api/pulse/schedules - Create a schedule
  router.post('/schedules', (req: Request, res: Response) => {
    const parsed = CreateScheduleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.format() });
      return;
    }
    if (!isWithinBoundary(parsed.data.cwd)) {
      res.status(403).json({ error: 'Working directory outside allowed boundary' });
      return;
    }
    const schedule = store.createSchedule(parsed.data);
    scheduler.registerSchedule(schedule);
    res.status(201).json(schedule);
  });

  // PATCH /api/pulse/schedules/:id - Update a schedule
  router.patch('/schedules/:id', (req: Request, res: Response) => {
    const parsed = UpdateScheduleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.format() });
      return;
    }
    if (parsed.data.cwd && !isWithinBoundary(parsed.data.cwd)) {
      res.status(403).json({ error: 'Working directory outside allowed boundary' });
      return;
    }
    try {
      const schedule = store.updateSchedule(req.params.id, parsed.data);
      if (schedule.enabled && schedule.status === 'active') {
        scheduler.registerSchedule(schedule);
      } else {
        scheduler.unregisterSchedule(schedule.id);
      }
      res.json(schedule);
    } catch {
      res.status(404).json({ error: 'Schedule not found' });
    }
  });

  // DELETE /api/pulse/schedules/:id
  router.delete('/schedules/:id', (req: Request, res: Response) => {
    scheduler.unregisterSchedule(req.params.id);
    store.deleteSchedule(req.params.id);
    res.json({ ok: true });
  });

  // POST /api/pulse/schedules/:id/trigger - Manual run
  router.post('/schedules/:id/trigger', async (req: Request, res: Response) => {
    try {
      const runId = await scheduler.triggerManualRun(req.params.id);
      res.json({ runId });
    } catch {
      res.status(404).json({ error: 'Schedule not found' });
    }
  });

  // GET /api/pulse/runs - List runs
  router.get('/runs', (req: Request, res: Response) => {
    const parsed = ListRunsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.format() });
      return;
    }
    const { schedule_id, limit, offset } = parsed.data;
    const runs = store.listRuns(
      schedule_id ? { scheduleId: schedule_id, limit, offset } : { limit, offset }
    );
    const total = store.countRuns(schedule_id);
    res.json({ runs, total });
  });

  // GET /api/pulse/runs/:id
  router.get('/runs/:id', (req: Request, res: Response) => {
    const run = store.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(run);
  });

  // POST /api/pulse/runs/:id/cancel
  router.post('/runs/:id/cancel', (req: Request, res: Response) => {
    try {
      scheduler.cancelRun(req.params.id);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'Run not found or not active' });
    }
  });

  return router;
}
```

2. Mount in `apps/server/src/app.ts` (conditional):

```typescript
if (app.locals.pulseStore && app.locals.schedulerService) {
  const { createPulseRouter } = await import('./routes/pulse.js');
  app.use('/api/pulse', createPulseRouter(app.locals.pulseStore, app.locals.schedulerService));
}
```

3. Write tests in `apps/server/src/routes/__tests__/pulse.test.ts`:
   - CRUD endpoints return correct status codes (200, 201, 400, 403, 404)
   - Zod validation rejects invalid cron and missing required fields
   - Trigger endpoint returns run ID
   - Cancel endpoint handles active/missing runs
   - Boundary validation on `cwd` field
   - Pagination for run listing
   - `GET /schedules` includes computed `nextRun` field

**Acceptance Criteria**:

- [ ] `routes/pulse.ts` created with 8 endpoints
- [ ] Mounted conditionally in `app.ts`
- [ ] Zod validation on all request bodies and query params
- [ ] Directory boundary enforced on `cwd` fields
- [ ] `nextRun` computed via croner for schedule listings
- [ ] Route tests pass

---

### Task 2.3: Wire Server Startup and Graceful Shutdown

**Description**: Integrate PulseStore and SchedulerService into server startup/shutdown lifecycle
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.2, Task 1.3, Task 2.1, Task 2.2
**Can run parallel with**: None

**Technical Requirements**:

- Conditional initialization based on config/env
- Pass `pulseStore` to MCP tool server
- Set `app.locals` for route access
- Graceful shutdown calls `schedulerService.stop()`

**Implementation Steps**:

1. Update `apps/server/src/index.ts`:

```typescript
import { PulseStore } from './services/pulse-store.js';
import { SchedulerService } from './services/scheduler-service.js';
import os from 'os';
import path from 'path';

// Inside start():
const schedulerConfig = configManager?.get('scheduler');
const pulseEnabled =
  process.env.DORKOS_PULSE_ENABLED === 'true' || schedulerConfig?.enabled === true;

const dorkHome = process.env.DORK_HOME ?? path.join(os.homedir(), '.dork');

let pulseStore: PulseStore | undefined;
let schedulerService: SchedulerService | undefined;

if (pulseEnabled) {
  pulseStore = new PulseStore(dorkHome);
  schedulerService = new SchedulerService(pulseStore, agentManager, {
    maxConcurrentRuns: schedulerConfig?.maxConcurrentRuns ?? 1,
    timezone: schedulerConfig?.timezone ?? undefined,
    retentionCount: schedulerConfig?.retentionCount ?? 100,
  });
}

// Pass pulseStore to MCP tool server
const mcpToolServer = createDorkOsToolServer({
  transcriptReader,
  defaultCwd: process.env.DORKOS_DEFAULT_CWD ?? process.cwd(),
  pulseStore,
});

// After app creation, set locals
app.locals.pulseStore = pulseStore;
app.locals.schedulerService = schedulerService;

// Start scheduler after server binds
if (schedulerService) schedulerService.start();

// Update graceful shutdown
async function shutdown() {
  if (schedulerService) await schedulerService.stop();
  if (sessionBroadcaster) sessionBroadcaster.shutdown();
  process.exit(0);
}
```

**Acceptance Criteria**:

- [ ] Pulse conditionally initializes based on config/env
- [ ] `pulseStore` passed to MCP tool server
- [ ] Scheduler starts after server binds
- [ ] Graceful shutdown stops scheduler before process exit
- [ ] Server starts normally when Pulse is disabled

---

## Phase 3: Client UI

### Task 3.1: Extend Transport Interface and HttpTransport

**Description**: Add Pulse methods to the Transport interface and implement in HttpTransport
**Size**: Small
**Priority**: High
**Dependencies**: Task 2.2
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- Add 8 methods to `Transport` interface in `packages/shared/src/transport.ts`
- Implement in `HttpTransport` in client
- Stub in `DirectTransport` (Obsidian) with "not available" error

**Implementation Steps**:

1. Add to `packages/shared/src/transport.ts` Transport interface:

```typescript
import type {
  PulseSchedule, PulseRun, CreateScheduleRequest, UpdateScheduleRequest,
} from './types.js';

// Add these methods to the Transport interface:
listSchedules(): Promise<PulseSchedule[]>;
createSchedule(input: CreateScheduleRequest): Promise<PulseSchedule>;
updateSchedule(id: string, input: UpdateScheduleRequest): Promise<PulseSchedule>;
deleteSchedule(id: string): Promise<{ ok: boolean }>;
triggerSchedule(id: string): Promise<{ runId: string }>;
listRuns(opts?: { scheduleId?: string; limit?: number; offset?: number }): Promise<{ runs: PulseRun[]; total: number }>;
getRun(id: string): Promise<PulseRun>;
cancelRun(id: string): Promise<{ ok: boolean }>;
```

2. Implement in HttpTransport:

```typescript
async listSchedules(): Promise<PulseSchedule[]> {
  const res = await fetch(`${this.baseUrl}/api/pulse/schedules`);
  if (!res.ok) throw new Error('Failed to list schedules');
  return res.json();
}
async createSchedule(input: CreateScheduleRequest): Promise<PulseSchedule> {
  const res = await fetch(`${this.baseUrl}/api/pulse/schedules`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to create schedule');
  return res.json();
}
async updateSchedule(id: string, input: UpdateScheduleRequest): Promise<PulseSchedule> {
  const res = await fetch(`${this.baseUrl}/api/pulse/schedules/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to update schedule');
  return res.json();
}
async deleteSchedule(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${this.baseUrl}/api/pulse/schedules/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete schedule');
  return res.json();
}
async triggerSchedule(id: string): Promise<{ runId: string }> {
  const res = await fetch(`${this.baseUrl}/api/pulse/schedules/${id}/trigger`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to trigger schedule');
  return res.json();
}
async listRuns(opts?: { scheduleId?: string; limit?: number; offset?: number }): Promise<{ runs: PulseRun[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.scheduleId) params.set('schedule_id', opts.scheduleId);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const res = await fetch(`${this.baseUrl}/api/pulse/runs?${params}`);
  if (!res.ok) throw new Error('Failed to list runs');
  return res.json();
}
async getRun(id: string): Promise<PulseRun> {
  const res = await fetch(`${this.baseUrl}/api/pulse/runs/${id}`);
  if (!res.ok) throw new Error('Failed to get run');
  return res.json();
}
async cancelRun(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${this.baseUrl}/api/pulse/runs/${id}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to cancel run');
  return res.json();
}
```

3. Stub in DirectTransport:

```typescript
listSchedules() { return Promise.reject(new Error('Pulse not available in Obsidian')); }
createSchedule() { return Promise.reject(new Error('Pulse not available in Obsidian')); }
updateSchedule() { return Promise.reject(new Error('Pulse not available in Obsidian')); }
deleteSchedule() { return Promise.reject(new Error('Pulse not available in Obsidian')); }
triggerSchedule() { return Promise.reject(new Error('Pulse not available in Obsidian')); }
listRuns() { return Promise.reject(new Error('Pulse not available in Obsidian')); }
getRun() { return Promise.reject(new Error('Pulse not available in Obsidian')); }
cancelRun() { return Promise.reject(new Error('Pulse not available in Obsidian')); }
```

4. Update `createMockTransport` in `packages/test-utils/` to include Pulse method stubs.

**Acceptance Criteria**:

- [ ] Transport interface has 8 new Pulse methods
- [ ] HttpTransport implements all methods
- [ ] DirectTransport stubs reject with "not available in Obsidian"
- [ ] `createMockTransport` updated
- [ ] `npm run typecheck` passes

---

### Task 3.2: Create Entity Hooks (use-schedules, use-runs)

**Description**: Create TanStack Query hooks for schedule and run data fetching
**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Technical Requirements**:

- FSD entity layer: `apps/client/src/layers/entities/pulse/`
- TanStack Query hooks with proper cache invalidation
- Barrel export at `entities/pulse/index.ts`

**Implementation Steps**:

1. Create `apps/client/src/layers/entities/pulse/model/use-schedules.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { CreateScheduleRequest, UpdateScheduleRequest } from '@dorkos/shared/types';

const SCHEDULES_KEY = ['pulse', 'schedules'] as const;

export function useSchedules() {
  const transport = useTransport();
  return useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: () => transport.listSchedules(),
  });
}

export function useCreateSchedule() {
  const transport = useTransport();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateScheduleRequest) => transport.createSchedule(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  });
}

export function useUpdateSchedule() {
  const transport = useTransport();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdateScheduleRequest) =>
      transport.updateSchedule(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  });
}

export function useDeleteSchedule() {
  const transport = useTransport();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  });
}

export function useTriggerSchedule() {
  const transport = useTransport();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.triggerSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pulse', 'runs'] }),
  });
}
```

2. Create `apps/client/src/layers/entities/pulse/model/use-runs.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export function useRuns(opts?: { scheduleId?: string; limit?: number; offset?: number }) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['pulse', 'runs', opts] as const,
    queryFn: () => transport.listRuns(opts),
    refetchInterval: 10_000,
  });
}

export function useRun(id: string) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['pulse', 'runs', id] as const,
    queryFn: () => transport.getRun(id),
    enabled: !!id,
  });
}

export function useCancelRun() {
  const transport = useTransport();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.cancelRun(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pulse', 'runs'] }),
  });
}
```

3. Create barrel: `apps/client/src/layers/entities/pulse/index.ts`:

```typescript
/**
 * Pulse entity - domain hooks for schedule and run lifecycle.
 * @module entities/pulse
 */
export {
  useSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
  useTriggerSchedule,
} from './model/use-schedules';
export { useRuns, useRun, useCancelRun } from './model/use-runs';
```

4. Write tests in `apps/client/src/layers/entities/pulse/__tests__/use-schedules.test.ts`:
   - Fetches and caches schedule list
   - Invalidates cache after create/update/delete mutations

**Acceptance Criteria**:

- [ ] Entity hooks created in FSD layer
- [ ] TanStack Query keys properly structured
- [ ] Cache invalidation on mutations
- [ ] Barrel export at `entities/pulse/index.ts`
- [ ] Tests pass

---

### Task 3.3: Create PulsePanel Component

**Description**: Build the main Pulse UI panel showing schedule list with status indicators and controls
**Size**: Large
**Priority**: Medium
**Dependencies**: Task 3.2
**Can run parallel with**: Task 3.4, Task 3.5

**Technical Requirements**:

- FSD feature layer: `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx`
- Uses `cronstrue` for human-readable cron display
- Status indicators: green (active), gray (paused), red (last failed), yellow (pending_approval)
- Enable/disable toggle, "Run Now" button, approval UI

**Implementation Steps**:

1. Create `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx`:
   - Import hooks from `@/layers/entities/pulse`
   - Import `cronstrue` for cron display: `cronstrue.toString(schedule.cron)`
   - Render schedule list as scrollable card/table layout
   - Each row: status dot, name, human-readable cron, next run time, enabled Switch toggle
   - Status dot: `bg-green-500` (active), `bg-neutral-400` (paused), `bg-red-500` (last failed), `bg-yellow-500` (pending_approval)
   - "Run Now" button per schedule calls `useTriggerSchedule().mutate(id)`
   - "New Schedule" button opens CreateScheduleDialog
   - Enabled toggle calls `useUpdateSchedule().mutate({ id, enabled: !current })`
   - Click row expands/collapses RunHistoryPanel inline
   - Empty state: "No scheduled jobs. Create one to get started."
   - Pending approval: yellow banner with "Approve" (sets status: active) and "Reject" (deletes) buttons

2. Write tests `apps/client/src/layers/features/pulse/__tests__/PulsePanel.test.tsx`:
   - Renders schedule list with correct status indicators
   - Enabled toggle calls update endpoint
   - "Run Now" calls trigger endpoint
   - Empty state when no schedules
   - Pending approval actions work

**Acceptance Criteria**:

- [ ] PulsePanel renders schedule list with status indicators
- [ ] `cronstrue` converts cron to human-readable text
- [ ] Enable/disable toggle works
- [ ] "Run Now" triggers manual run
- [ ] Approval UI for pending schedules
- [ ] Empty state displayed
- [ ] Component tests pass

---

### Task 3.4: Create CreateScheduleDialog Component

**Description**: Build the schedule creation/editing dialog form
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.2
**Can run parallel with**: Task 3.3, Task 3.5

**Technical Requirements**:

- File: `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`
- Uses shadcn Dialog, Input, Textarea, Select
- Live cron preview via `cronstrue`
- Permission mode warning for `bypassPermissions`

**Implementation Steps**:

1. Create `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`:
   - Props: `open: boolean`, `onOpenChange: (open: boolean) => void`, `editSchedule?: PulseSchedule`
   - Form fields:
     - **Name**: `<Input>` required, max 100 chars
     - **Prompt**: `<Textarea>` required, multiline, rows=4
     - **Cron expression**: `<Input>` with live `cronstrue.toString(value)` below (wrap in try/catch for invalid input)
     - **Working directory**: Reuse DirectoryPicker component
     - **Timezone**: `<Select>` using `Intl.supportedValuesOf('timeZone')`, default system timezone
     - **Permission mode**: Radio group - "Allow file edits" (acceptEdits) / "Full autonomy" (bypassPermissions)
       - Warning when bypassPermissions: "This allows the agent to make changes without approval."
     - **Max runtime**: Number input in minutes (convert to ms), default 10
   - Submit: `useCreateSchedule().mutate(input)` or `useUpdateSchedule().mutate({id, ...input})`
   - Validation: required fields, close on success

2. Write tests `apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`:
   - Required field validation
   - Permission mode warning visibility
   - Submit calls create with correct payload
   - Cron preview updates on input

**Acceptance Criteria**:

- [ ] Dialog form with all fields from spec
- [ ] Live cron expression translation
- [ ] Permission mode warning displayed
- [ ] Required field validation
- [ ] Tests pass

---

### Task 3.5: Create RunHistoryPanel Component

**Description**: Build the run history table for a schedule
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.2
**Can run parallel with**: Task 3.3, Task 3.4

**Technical Requirements**:

- File: `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`
- Table with status icon, trigger type, start time, duration, output preview
- Click run navigates to chat UI with session ID
- Cancel button on running jobs
- Pagination

**Implementation Steps**:

1. Create `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`:
   - Props: `scheduleId: string`
   - Use `useRuns({ scheduleId, limit: 20 })` hook
   - Table columns: Status (icon), Trigger (badge), Started, Duration (formatted), Output preview
   - Status icons: spinner/loader (running), check-circle (completed), x-circle (failed), slash (cancelled)
   - Click row navigates to `/?session=${run.sessionId}` (only if sessionId exists)
   - "Cancel" button on running rows calls `useCancelRun().mutate(run.id)`
   - Duration format: `< 1s`, `Xs`, `Xm Ys`
   - Pagination: "Load more" button
   - Empty state: "No runs yet"

2. Write tests:
   - Renders run history table
   - Cancel button visible only for running jobs
   - Click navigates to session
   - Empty state shown

**Acceptance Criteria**:

- [ ] Run history table with all columns
- [ ] Session linkage navigation
- [ ] Cancel button on running jobs
- [ ] Pagination
- [ ] Tests pass

---

### Task 3.6: Create Feature Barrel and Integrate PulsePanel

**Description**: Create barrel export and integrate PulsePanel into the app layout
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.3, Task 3.4, Task 3.5
**Can run parallel with**: None

**Technical Requirements**:

- Feature barrel at `features/pulse/index.ts`
- Add Pulse section to sidebar or settings area
- Conditionally render based on Pulse availability

**Implementation Steps**:

1. Create `apps/client/src/layers/features/pulse/index.ts`:

```typescript
/**
 * Pulse feature - scheduler UI for managing scheduled agent jobs.
 * @module features/pulse
 */
export { PulsePanel } from './ui/PulsePanel';
export { CreateScheduleDialog } from './ui/CreateScheduleDialog';
export { RunHistoryPanel } from './ui/RunHistoryPanel';
```

2. Integrate into app:
   - Add "Pulse" section/tab in sidebar or settings
   - Conditionally render (check server config or schedules endpoint)
   - Add navigation to PulsePanel

**Acceptance Criteria**:

- [ ] Barrel export at `features/pulse/index.ts`
- [ ] PulsePanel accessible from sidebar/settings
- [ ] Conditional rendering when Pulse is disabled

---

## Phase 4: Polish

### Task 4.1: Add CLI --pulse Flag

**Description**: Add --pulse/--no-pulse CLI flags to control scheduler at startup
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.3
**Can run parallel with**: Task 4.2, Task 4.3

**Technical Requirements**:

- Update `packages/cli/src/cli.ts`
- Set `DORKOS_PULSE_ENABLED` env var
- Precedence: CLI flag > env var > config > default (false)

**Implementation Steps**:

1. Add flag to CLI command definition:

```typescript
.option('--pulse', 'Enable Pulse scheduler')
.option('--no-pulse', 'Disable Pulse scheduler')
```

2. Before server import, set env var:

```typescript
if (options.pulse !== undefined) {
  process.env.DORKOS_PULSE_ENABLED = options.pulse ? 'true' : 'false';
}
```

**Acceptance Criteria**:

- [ ] `--pulse` enables scheduler
- [ ] `--no-pulse` disables scheduler
- [ ] Precedence chain works correctly

---

### Task 4.2: Register Pulse Schemas in OpenAPI Registry

**Description**: Register all Pulse schemas for auto-generated API documentation
**Size**: Small
**Priority**: Low
**Dependencies**: Task 1.1, Task 2.2
**Can run parallel with**: Task 4.1, Task 4.3

**Technical Requirements**:

- Update `apps/server/src/services/openapi-registry.ts`
- Register all Pulse request/response schemas
- Document all 8 endpoints with path/method/tags

**Implementation Steps**:

1. Register schemas following existing patterns in openapi-registry.ts
2. Add route documentation for all 8 `/api/pulse/*` endpoints with Pulse tag

**Acceptance Criteria**:

- [ ] All Pulse schemas registered in OpenAPI
- [ ] `/api/docs` shows Pulse endpoints
- [ ] `npm run docs:export-api` generates updated spec

---

### Task 4.3: Update CLAUDE.md and Documentation

**Description**: Update project documentation to reflect Pulse feature
**Size**: Small
**Priority**: Low
**Dependencies**: All previous tasks
**Can run parallel with**: Task 4.1, Task 4.2

**Technical Requirements**:

- Update service count in CLAUDE.md (now 22 services: PulseStore + SchedulerService)
- Add PulseStore and SchedulerService to service list descriptions
- Add `routes/pulse.ts` to route group list
- Update CLI flags documentation with `--pulse`/`--no-pulse`
- Document `scheduler` config section
- Update dependency list

**Implementation Steps**:

1. Update `CLAUDE.md`:
   - Service list: add PulseStore and SchedulerService descriptions
   - Route groups: add pulse.ts entry (9th route group)
   - Update "Sixteen services" to "Eighteen services"
   - CLI flags: add --pulse/--no-pulse
   - Dependencies: mention better-sqlite3, croner, cronstrue
   - Config: mention scheduler section
   - FSD: add entities/pulse and features/pulse

2. Update `contributing/configuration.md` with scheduler config section

3. Update `contributing/api-reference.md` with /api/pulse/\* endpoints

**Acceptance Criteria**:

- [ ] CLAUDE.md reflects new services, routes, and CLI flags
- [ ] Configuration docs include scheduler section
- [ ] API reference includes Pulse endpoints
