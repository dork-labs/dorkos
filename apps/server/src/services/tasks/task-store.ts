import {
  eq,
  ne,
  desc,
  and,
  count,
  inArray,
  notInArray,
  lt,
  isNull,
  isNotNull,
  sql,
} from 'drizzle-orm';
import {
  pulseSchedules,
  pulseRuns,
  pulseDispatchLog,
  hasPercentileSupport,
  type Db,
} from '@dorkos/db';
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
import { logger } from '../../lib/logger.js';
import {
  FileSyncGates,
  fileProvenance,
  fileSettingsOf,
  type FileSyncSource,
} from './file-sync-gates.js';
import { TaskApprovals } from './approvals/task-approvals.js';
import { scheduleContentKey } from './schedule-permission-clamp.js';
import { mapTaskRow, mapRunRow } from './task-row-mappers.js';
import {
  effectiveContentKey,
  timingColumnWrites,
  type TimingLandsOn,
} from './timing/effective-timing.js';

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
  /** Whether every run resumes one persistent session (DOR-1571). Defaults off. */
  sticky?: boolean;
  maxRuntime?: number | null;
  permissionMode?: string;
  /** Which runtime this task's runs execute on; absent follows the agent (DOR-1615). */
  runtime?: string | null;
  /** The model its runs execute on, in the resolved runtime's id space (DOR-1347). */
  model?: string | null;
  /** The reasoning-effort rung its runs execute at. */
  effort?: string | null;
  filePath: string;
  /** Why the schedule should exist, in the proposer's own words. See {@link CreateTaskStoreInput.proposedByAgentPath}. */
  reason?: string | null;
  /** The session that proposed it, when an agent did. */
  proposedBySessionId?: string | null;
  /**
   * The proposing session's working directory — the key the agent-identity
   * service resolves a display name from. Stored rather than the name itself,
   * so a rename or a revocation is reflected the next time the task is read.
   */
  proposedByAgentPath?: string | null;
}

/**
 * Per-schedule reliability, computed over terminal runs (the
 * {@link TERMINAL_RUN_STATUSES} set, plus DB-only `timeout` rows).
 * See {@link TaskStore.getScheduleReliability}.
 */
export interface ScheduleReliability {
  /** The `pulseSchedules.id` this row covers. */
  scheduleId: string;
  /** Count of terminal runs included in this computation. */
  totalRuns: number;
  /** Fraction of terminal runs that ended `completed`, in `[0, 1]`. */
  successRate: number;
  /**
   * 95th percentile run duration in ms, over terminal runs with a recorded
   * `durationMs`. `null` when none do, or the linked better-sqlite3 binary
   * predates the percentile extension (DOR-166).
   */
  p95DurationMs: number | null;
}

/**
 * What {@link TaskStore.upsertFromFile} needs to know beyond the file itself:
 * who is writing, and what is wrong with the file.
 *
 * Defined by the module that acts on it — see {@link FileSyncSource}, which
 * documents both fields — and re-exported here under the name its one caller
 * uses.
 */
export type UpsertFromFileOptions = FileSyncSource;

/**
 * How {@link TaskStore.updateTask} writes a request's timing — see
 * {@link TimingLandsOn}.
 */
export interface UpdateTaskOptions {
  /**
   * Where `cron` and `timezone` go. `file` is every schedule whose SKILL.md
   * DorkOS writes; `row` is a package's schedule, whose timing becomes the
   * row's override. Decided by `applyTaskFileUpdate`, which is the one step
   * that asks whether a package owns the file.
   *
   * Required, with no default, for any update that carries timing: a silent
   * `file` would write a person's timing over a package's default and drop
   * their override, which is the one mistake a caller must not be able to make
   * by leaving an argument out.
   */
  timingLandsOn: TimingLandsOn;
}

/** An update that says nothing about timing, and so needs no {@link UpdateTaskOptions}. */
export type UntimedTaskUpdate = Omit<UpdateTaskRequest, 'cron' | 'timezone' | 'resetTiming'> & {
  cron?: never;
  timezone?: never;
  resetTiming?: never;
};

/** Fields that can be updated on a run. */
interface RunUpdate {
  status?: TaskRunStatus;
  finishedAt?: string;
  durationMs?: number;
  outputSummary?: string;
  error?: string;
  sessionId?: string;
  /**
   * The tools this run was refused for want of somebody to approve them, in
   * the order they were first refused. Omitted leaves the stored list alone;
   * `[]` is a real answer and clears it.
   */
  refusedTools?: string[];
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
  // A run that ran and was refused every tool it reached for (DOR-2101). It is
  // over, and it is not a failure — it was simply never allowed to do its job.
  'blocked',
  // A skipped tick never started, so it is over the instant it is written
  // (DOR-1482) — and being terminal is what stops anything from later
  // "finishing" a run that was never run.
  'skipped',
]);

/**
 * Whether a run status is terminal (see {@link TERMINAL_RUN_STATUSES}).
 *
 * @param status - The run status to classify.
 */
export function isTerminalRunStatus(status: TaskRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Every status that means a run is OVER, for queries that must not act on a run
 * that is still going.
 *
 * The terminal set plus `timeout`, which exists only in the DB column's enum:
 * no writer produces it today and the shared `TaskRunStatus` omits it, but a row
 * carrying it is plainly finished, and both readers below would otherwise treat
 * it as live for ever.
 */
const FINISHED_RUN_STATUSES = [...TERMINAL_RUN_STATUSES, 'timeout' as const];

/**
 * Callback fired exactly once when a run transitions to a terminal status
 * (DOR-240). The store stays a pure data layer: it holds this reference and
 * calls it fire-and-forget after the DB write — it contains no
 * binding/relay/notification logic of its own.
 *
 * @param run - The run as persisted at the terminal write.
 * @param task - The run's task, or null if it could not be read.
 */
export type RunTerminalListener = (run: TaskRun, task: Task | null) => void;

/**
 * Persistence layer for Task scheduler data.
 *
 * The DB is a derived cache — files on disk are the source of truth.
 * API routes write files first, then call `upsertFromFile()` or `createTask()`
 * for immediate consistency. The reconciler periodically re-syncs.
 */
export class TaskStore {
  private db: Db;
  /** Optional listener fired once per run's terminal transition (DOR-240). */
  private onRunTerminal: RunTerminalListener | null = null;
  /**
   * The content gates every file-sourced write passes: the permission clamp and
   * the arm gate, plus the memory that keeps a standing refusal from writing a
   * log line every five minutes (`file-sync-gates.ts`).
   */
  private readonly fileGates = new FileSyncGates();
  /**
   * The approval lifecycle, over this store's database (DOR-2329): recording,
   * withdrawing and settling a person's approval, and carrying it across a
   * file move or a key-format upgrade. See `approvals/task-approvals.ts`.
   */
  readonly approvals: TaskApprovals;

  constructor(db: Db) {
    this.db = db;
    this.approvals = new TaskApprovals(db);
  }

  /**
   * Register the run-terminal listener (DOR-240). Fired fire-and-forget exactly
   * once, on the write that moves a non-terminal run to a terminal status —
   * never on the already-terminal no-op, never on a `running` write. When unset
   * (tests, `packages/relay` consumers that build their own store), behavior is
   * unchanged.
   *
   * @param listener - Callback invoked after the terminal DB write.
   */
  setOnRunTerminal(listener: RunTerminalListener): void {
    this.onRunTerminal = listener;
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
        sticky: input.sticky ?? false,
        maxRuntime: input.maxRuntime ?? null,
        permissionMode: input.permissionMode ?? 'acceptEdits',
        runtime: input.runtime ?? null,
        model: input.model ?? null,
        effort: input.effort ?? null,
        status: 'active',
        // An operator create is itself the approval, so the row arrives armed.
        // A caller that must not arm anything — an agent — is parked by the
        // route straight after, and that park withdraws this through
        // `updateTask`.
        approvedContentKey: scheduleContentKey({
          prompt: input.prompt,
          cron: input.cron ?? '',
          timezone: input.timezone ?? 'UTC',
          name: input.name,
          runtime: input.runtime ?? null,
          model: input.model ?? null,
          effort: input.effort ?? null,
          maxRuntime: input.maxRuntime ?? null,
          sticky: input.sticky ?? false,
        }),
        filePath: input.filePath,
        reason: input.reason ?? null,
        proposedBySessionId: input.proposedBySessionId ?? null,
        proposedByAgentPath: input.proposedByAgentPath ?? null,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.getTask(id)!;
  }

  /**
   * Update an existing task. Returns the updated task or null if not found.
   *
   * An update carrying `cron`, `timezone` or `resetTiming` must say where its
   * timing lands ({@link UpdateTaskOptions}); the types require it, and so does
   * this method, for a caller the types cannot see.
   *
   * @param id - The task to update.
   * @param input - The fields to change; an omitted field is left alone.
   * @param options - Where the request's timing lands; see {@link UpdateTaskOptions}.
   */
  updateTask(id: string, input: UntimedTaskUpdate): Task | null;
  updateTask(id: string, input: UpdateTaskRequest, options: UpdateTaskOptions): Task | null;
  updateTask(id: string, input: UpdateTaskRequest, options?: UpdateTaskOptions): Task | null {
    const carriesTiming =
      input.cron !== undefined || input.timezone !== undefined || input.resetTiming !== undefined;
    if (carriesTiming && !options) {
      throw new Error('updateTask: an update carrying timing must say where it lands');
    }
    const existing = this.db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get();
    if (!existing) return null;

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (input.name !== undefined) updates.name = input.name;
    if (input.displayName !== undefined) updates.displayName = input.displayName ?? null;
    if (input.description !== undefined) updates.description = input.description;
    if (input.prompt !== undefined) updates.prompt = input.prompt;
    // `''`, never `null` — the column is NOT NULL and an empty cron is what
    // "on demand" means in it, the same way {@link createTask} and
    // {@link upsertFromFile} both already write it (`registerTask` reads a
    // falsy cron as "do not schedule this"). A literal null threw a NOT NULL
    // constraint error straight out of this method, and the cockpit's edit form
    // sends exactly that on every save of a task with no cron
    // (`cron: cronTrimmed || null` in `TaskFormInner.tsx`) — so editing an
    // on-demand task's prompt failed, AFTER its file had already been rewritten.
    //
    // For a package's schedule the same two fields land in the override
    // columns instead, and a reset clears them (DOR-2302) — one rule, in
    // `timingColumnWrites`, so the NOT NULL spelling above holds on both paths.
    Object.assign(updates, timingColumnWrites(existing, input, options?.timingLandsOn ?? 'file'));
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.sticky !== undefined) updates.sticky = input.sticky;
    if (input.maxRuntime !== undefined) {
      updates.maxRuntime =
        typeof input.maxRuntime === 'string' ? parseDuration(input.maxRuntime) : null;
    }
    if (input.permissionMode !== undefined) updates.permissionMode = input.permissionMode;
    // `null` CLEARS the override, which is a state a person chooses: back to
    // "whatever this task's agent runs on". The column and the request spell it
    // the same way, so the three need no translation (DOR-1615/DOR-1347).
    if (input.runtime !== undefined) updates.runtime = input.runtime;
    if (input.model !== undefined) updates.model = input.model;
    if (input.effort !== undefined) updates.effort = input.effort;
    if (input.status !== undefined) updates.status = input.status;

    this.db.update(pulseSchedules).set(updates).where(eq(pulseSchedules.id, id)).run();

    // **Status changes through this method ARE the operator's decision.**
    //
    // `status` is operator-only (`task-write-policy.ts`), so anything reaching
    // here with one has already cleared the agent bar — which makes this the one
    // place a person's approval can be recorded, and the one place it must be
    // withdrawn. Doing it centrally rather than in the route is what keeps the
    // MCP tools, the CLI and any future writer honest without each remembering.
    //
    // Read AFTER the update, deliberately: a single PATCH may change the cron
    // and approve it in the same breath, and what was approved is the content
    // the caller is leaving behind, not the one they found.
    if (input.status === 'active') this.approvals.recordApproval(id);
    else if (input.status !== undefined) this.approvals.withdrawApproval(id);

    return this.getTask(id);
  }

  /**
   * Record who proposed a schedule and why, on a row that already exists.
   *
   * Separate from {@link updateTask} rather than folded into it, because these
   * are not fields a task write may carry. `proposedByAgentPath` is stamped from
   * a resolved credential and `proposedBySessionId` from the invoking session —
   * both are things the server KNOWS about a caller, and a caller that could
   * send them could claim to be any agent it liked.
   *
   * `reason` rides along here rather than through the update mapping for the
   * same reason it is written at all: it belongs to the proposal, and the only
   * moment it is set is the moment a schedule parks.
   *
   * Exists because the REST create path writes a file first and syncs through
   * `upsertFromFile`, which builds its row from a SKILL.md and so has nowhere to
   * carry any of this. The MCP path calls `createTask` and needs none of it.
   *
   * @param id - The task to stamp.
   * @param proposal - The fields to write; an omitted field is left alone.
   * @returns The updated task, or null when no such task exists.
   */
  recordProposal(
    id: string,
    proposal: {
      reason?: string | null;
      proposedBySessionId?: string | null;
      proposedByAgentPath?: string | null;
    }
  ): Task | null {
    if (!this.getTask(id)) return null;

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (proposal.reason !== undefined) {
      updates.reason = proposal.reason;
      // A proposer's own words, so the card quotes them and names who said it.
      // Clearing the marker matters on a row DorkOS had written a reason onto
      // earlier: without it, a real proposal would keep rendering as our prose.
      updates.reasonSource = null;
    }
    if (proposal.proposedBySessionId !== undefined)
      updates.proposedBySessionId = proposal.proposedBySessionId;
    if (proposal.proposedByAgentPath !== undefined)
      updates.proposedByAgentPath = proposal.proposedByAgentPath;

    this.db.update(pulseSchedules).set(updates).where(eq(pulseSchedules.id, id)).run();
    return this.getTask(id);
  }

  /**
   * Delete a task and everything keyed to it. Returns true if found and deleted.
   *
   * Both child deletes are explicit, in one transaction, rather than left to
   * the database:
   *
   * - `pulse_runs` has an `ON DELETE CASCADE` foreign key, so the delete would
   *   succeed without this. It stays because the cascade is only in force while
   *   `foreign_keys = ON`; a connection opened without that pragma would leave
   *   run rows pointing at a task that no longer exists.
   * - `pulse_dispatch_log` has no foreign key at all (it is a dedup ledger keyed
   *   on task id, deliberately unconstrained so a claim is one cheap INSERT).
   *   Nothing else deletes its rows on task deletion — the scheduler only prunes
   *   them on a 7-day TTL, and only at startup — so without this they outlive
   *   the task they belong to.
   */
  deleteTask(id: string): boolean {
    // Read the path before the row goes: the reconciler deletes tasks whose file
    // has been gone for 24 hours, and a refusal remembered against a path with
    // no task left would silence the first warning about whatever lands there
    // next.
    const filePath = this.db
      .select({ filePath: pulseSchedules.filePath })
      .from(pulseSchedules)
      .where(eq(pulseSchedules.id, id))
      .get()?.filePath;

    const deleted = this.db.transaction((tx) => {
      tx.delete(pulseRuns).where(eq(pulseRuns.scheduleId, id)).run();
      tx.delete(pulseDispatchLog).where(eq(pulseDispatchLog.taskId, id)).run();
      const result = tx.delete(pulseSchedules).where(eq(pulseSchedules.id, id)).run();
      return result.changes > 0;
    });

    if (deleted && filePath) this.fileGates.forget(filePath);
    return deleted;
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
   * Stamp what a run RESOLVED to execute on, at the moment it is dispatched
   * (DOR-1615/DOR-1347).
   *
   * Its own method rather than a widening of {@link updateRun}, for two reasons
   * that both matter. This is not a lifecycle update — it records a fact settled
   * before the turn starts, and it must land whatever the run then does. And
   * `updateRun` deliberately ignores a write to a run that already reached a
   * terminal status; in-process relay delivery runs an entire turn inside
   * `publish()`, so a stamp written on that path afterwards would be silently
   * dropped. Both dispatch paths therefore call this BEFORE they hand the work
   * over, where the run is by construction still open.
   *
   * `null` for the model is a real answer and is stored as one: nothing chose a
   * model, so the runtime picked.
   *
   * @param id - The run being dispatched.
   * @param execution - The resolved runtime, and the model if one was chosen.
   */
  recordRunExecution(id: string, execution: { runtime: string; model?: string | null }): void {
    this.db
      .update(pulseRuns)
      .set({ resolvedRuntime: execution.runtime, resolvedModel: execution.model ?? null })
      .where(eq(pulseRuns.id, id))
      .run();
  }

  /**
   * Update fields on an existing run. Returns the updated run or null.
   *
   * A run's outcome is immutable once terminal (`completed`/`failed`/
   * `cancelled`/`skipped`, see {@link isTerminalRunStatus}): this is a no-op that
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
        // Serialized here rather than by the caller, so the one shape this
        // column holds is decided in one place. An absent list leaves the
        // stored value alone, exactly as every field above does.
        refusedTools:
          update.refusedTools !== undefined
            ? JSON.stringify(update.refusedTools)
            : existing.refusedTools !== null
              ? JSON.stringify(existing.refusedTools)
              : null,
      })
      .where(eq(pulseRuns.id, id))
      .run();

    const updated = this.getRun(id);

    // Terminal hook (DOR-240): fire exactly once, only on the write that moves a
    // non-terminal run to a terminal status. Reaching here means the guard above
    // did NOT short-circuit, so `existing` was non-terminal; a terminal
    // `update.status` is therefore a genuine non-terminal→terminal transition.
    // Dispatched fire-and-forget so notification latency never blocks the status
    // write, and wrapped so a listener throw can never corrupt run persistence.
    if (this.onRunTerminal && updated && update.status && isTerminalRunStatus(update.status)) {
      const listener = this.onRunTerminal;
      const task = this.getTask(updated.scheduleId);
      queueMicrotask(() => {
        try {
          listener(updated, task);
        } catch (err) {
          logger.debug(`TaskStore: onRunTerminal listener threw for run ${id}`, err);
        }
      });
    }

    return updated;
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

  /**
   * Whether this task already has a run in flight (DOR-1571).
   *
   * The single-session serialization a STICKY task needs: it runs everything on
   * one session, so a fire that arrives while the previous run is still going
   * must NOT start a second turn on it. The scheduler asks this before claiming
   * a tick and writes a `skipped` run instead, exactly as it does at the
   * concurrency cap — the session is left to finish the turn it is on rather
   * than corrupted with two at once.
   *
   * A `running` row is the only non-terminal status a run can hold (every other
   * status is in {@link TERMINAL_RUN_STATUSES}), so this is the whole test.
   *
   * @param taskId - The task to check.
   * @returns True when a run of this task is currently `running`.
   */
  hasRunningRunForTask(taskId: string): boolean {
    const row = this.db
      .select({ id: pulseRuns.id })
      .from(pulseRuns)
      .where(and(eq(pulseRuns.scheduleId, taskId), eq(pulseRuns.status, 'running')))
      .limit(1)
      .get();
    return row !== undefined;
  }

  /**
   * The REAL SDK session id of this task's most recent run that actually ran a
   * turn — the resume target for the next sticky fire (DOR-1571).
   *
   * A run row carries `sessionId` only once it reaches a terminal status, and a
   * sticky run writes the runtime's OWN session id there (the UUID the SDK minted
   * or kept), not a synthetic one — because the SDK writes its transcript on disk
   * under that id, and resume finds `{sessionId}.jsonl` only when the id is the
   * real one (`launch-resolver.ts` sets `resume = session.sdkSessionId`). So the
   * most recent run's stored id is exactly the session the next fire must resume
   * to pick the conversation back up, cold across eviction and restart. The very
   * first fire finds none and starts fresh; every later fire resumes.
   *
   * A `skipped` run never ran and never wrote a `sessionId`, so it is correctly
   * absent; the current (still-running) run has a NULL `sessionId` too, so it can
   * never be its own resume target.
   *
   * ## …and which runtime it ran on
   *
   * Returned from the SAME row, deliberately, because a sticky task that has
   * since been moved to another runtime must NOT resume it (ADR-0255,
   * DOR-1615): a session belongs to one runtime and the id names a transcript in
   * that program's store.
   *
   * The run row is the authority on that, not `session_metadata`. Only an
   * interactive session ever calls `persistSessionRuntime`, so a scheduled run's
   * session has no binding recorded — asking the registry answered `null` for
   * every scheduled run ever made, which made the rule inert in production
   * (DOR-1615 review). `resolved_runtime` is stamped by the scheduler on every
   * dispatch, so it is the one place the answer actually exists.
   *
   * One query rather than two, so the id and the runtime cannot come from
   * different runs.
   *
   * @param taskId - The task whose latest session to resume.
   * @returns The resume target and the runtime it ran on, or null when none has
   *   run yet. `runtime` is null for a run recorded before that column existed,
   *   which reads as "no owner on record" and never as a mismatch.
   */
  latestStickyRun(taskId: string): { sessionId: string; runtime: string | null } | null {
    const row = this.db
      .select({ sessionId: pulseRuns.sessionId, runtime: pulseRuns.resolvedRuntime })
      .from(pulseRuns)
      .where(and(eq(pulseRuns.scheduleId, taskId), isNotNull(pulseRuns.sessionId)))
      // `created_at` is an ISO string at millisecond resolution with no
      // tiebreaker, so two runs written in the same millisecond order
      // arbitrarily (the same hazard `pruneRuns` documents). Here the tie would
      // resume the WRONG session, so `rowid` — strict insertion order — breaks
      // it deterministically toward the run written last.
      .orderBy(desc(pulseRuns.createdAt), sql`rowid DESC`)
      .limit(1)
      .get();
    return row?.sessionId ? { sessionId: row.sessionId, runtime: row.runtime ?? null } : null;
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

  /**
   * Prune old runs, keeping the most recent `retentionCount` per task.
   *
   * **A run that has not finished is never deleted, however old it is.**
   * Retention is about HISTORY, and a live run is not history — deleting its
   * row mid-flight destroys the only record of work that is still happening:
   * the scheduler's terminal write then finds nothing to update and the outcome
   * is discarded, the run-terminal hook never fires (no notification, no
   * attention badge), and the concurrency slot it was holding is silently
   * handed back, so the cap quietly grows.
   *
   * This guard was not needed while pruning happened once, at startup, directly
   * after a sweep that had just ended every running row — there was no live run
   * left for it to hit. Both halves of that changed in DOR-1482: pruning now
   * runs hourly, and the sweep deliberately leaves other processes' runs alone.
   * So the protection has to be stated here rather than inherited from when it
   * is called.
   *
   * Written as "delete only what is finished" rather than "skip `running`", so
   * a status added later is protected by default and has to be opted IN to
   * deletion.
   *
   * ## `retentionCount` counts FINISHED runs
   *
   * The keeper query is restricted the same way, so a live run never occupies a
   * keeper slot. Two things go wrong when it can. `created_at` is an ISO string
   * at millisecond resolution with no tiebreaker, so runs written in the same
   * millisecond order arbitrarily — a live run can win a slot on one pass and
   * lose it on the next, which makes how much history survives depend on a
   * coin toss. And a slot spent on a run that is protected anyway is a slot not
   * spent on history, so "keep the last 100" silently kept 99 whenever a run
   * was in flight.
   *
   * @param taskId - The task whose history is being trimmed.
   * @param retentionCount - How many of the newest FINISHED runs to keep.
   * @returns How many rows were deleted.
   */
  pruneRuns(taskId: string, retentionCount: number): number {
    const keepers = this.db
      .select({ id: pulseRuns.id })
      .from(pulseRuns)
      .where(
        and(eq(pulseRuns.scheduleId, taskId), inArray(pulseRuns.status, FINISHED_RUN_STATUSES))
      )
      .orderBy(desc(pulseRuns.createdAt))
      .limit(retentionCount)
      .all();

    const keeperIds = keepers.map((r) => r.id);

    const conditions = [
      eq(pulseRuns.scheduleId, taskId),
      inArray(pulseRuns.status, FINISHED_RUN_STATUSES),
    ];
    if (keeperIds.length > 0) conditions.push(notInArray(pulseRuns.id, keeperIds));

    const result = this.db
      .delete(pulseRuns)
      .where(and(...conditions))
      .run();
    return result.changes;
  }

  /**
   * Atomically claim a scheduled tick AND open its run row, in one transaction
   * (ADR-285; made atomic by DOR-1482).
   *
   * The claim is backed by a UNIQUE index, so `INSERT … ON CONFLICT DO NOTHING`
   * succeeds for exactly one caller per tick across every process sharing this
   * database. The run row rides in the SAME transaction because the two used to
   * be consecutive statements, and a process that died between them consumed
   * the occurrence for the whole seven-day dedup window while leaving no
   * evidence it had ever happened: no run row, nothing in the history, and a
   * `nextRun` that had already moved on. Either both rows exist or neither
   * does, so a crashed dispatch is simply a tick that was never claimed and the
   * next process to see it may take it.
   *
   * @param taskId - The task being dispatched.
   * @param scheduledFireTime - The cron's intended tick (epoch ms), not wall-clock.
   * @param outcome - `running` opens a live run; `skipped` records a tick this
   *   scheduler deliberately did not run, with the reason a person will read.
   * @returns The new run, or null when another caller already claimed this tick.
   */
  claimScheduledRun(
    taskId: string,
    scheduledFireTime: number,
    outcome: { status: 'running' } | { status: 'skipped'; reason: string }
  ): TaskRun | null {
    const now = new Date().toISOString();
    const runId = this.db.transaction((tx) => {
      const claim = tx
        .insert(pulseDispatchLog)
        .values({ taskId, scheduledFireTime, dispatchedAt: Date.now() })
        .onConflictDoNothing()
        .run();
      if (claim.changes !== 1) return null;

      const id = ulid();
      tx.insert(pulseRuns)
        .values({
          id,
          scheduleId: taskId,
          status: outcome.status,
          startedAt: now,
          trigger: 'scheduled',
          createdAt: now,
          // A skipped tick is over the moment it is recorded: it has an ending,
          // it took no time, and the reason is the whole point of writing it.
          ...(outcome.status === 'skipped'
            ? { finishedAt: now, durationMs: 0, error: outcome.reason }
            : {}),
        })
        .run();
      return id;
    });

    return runId ? this.getRun(runId) : null;
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
   * Mark NAMED runs as failed because a restart interrupted them (DOR-249).
   *
   * Takes explicit ids rather than sweeping every `running` row, which is what
   * this used to do: the database is shared by every process using one
   * `dorkHome` (ADR-285), so an unscoped sweep let one process's boot end
   * another process's live runs. Deciding WHICH runs a crash left behind is a
   * judgement about leadership and ownership, so it lives in
   * `crash-recovery.ts`; this method only carries out the decision.
   *
   * Scoped to rows that are genuinely unfinished (`finishedAt IS NULL`) —
   * a `running` row that already carries a real `finishedAt` was completed
   * and is only sitting in `running` due to a status-write race (the
   * `updateRun` terminal guard above closes that race going forward, but
   * this sweep must not assume every writer is patched). Never overwrite an
   * existing `finishedAt`: that timestamp is the only record of when the run
   * actually finished.
   *
   * @param runIds - The runs to end. An empty list writes nothing.
   * @returns How many rows were changed.
   */
  markRunsInterrupted(runIds: string[]): number {
    if (runIds.length === 0) return 0;
    const now = new Date().toISOString();
    const result = this.db
      .update(pulseRuns)
      .set({
        status: 'failed',
        finishedAt: now,
        error: 'Interrupted by server restart',
      })
      .where(
        and(
          inArray(pulseRuns.id, runIds),
          eq(pulseRuns.status, 'running'),
          isNull(pulseRuns.finishedAt)
        )
      )
      .run();
    return result.changes;
  }

  /**
   * Pause every task linked to an agent that was just unregistered.
   *
   * Mirrors {@link markRemovedByFilePath} on purpose (DOR-2082, follow-up to
   * DOR-2058): `status: 'paused'` alone stops the clock — the scheduler and
   * the registrar both require `enabled` AND `active` — and `enabled` is left
   * untouched because it is a person's switch, not the server's. This used to
   * write `enabled: false` too, which meant re-registering the agent brought
   * an approved, switched-on package schedule back APPROVED but switched OFF:
   * `upsertFromFile`'s package-owned branch (`file-sync-gates.ts`,
   * `keepsRowEnabled`) leaves `enabled` exactly as the row already has it
   * once the approval still stands, so a wrongly-written `false` here would
   * never self-heal.
   *
   * No status VALUE filter, same as `markRemovedByFilePath`: a
   * `pending_approval` row gets paused too, and un-parks back to
   * `pending_approval` (never `active`) the moment discovery re-reads its
   * file, because nothing here ever touches the stored approval key. It DOES
   * exclude rows already `paused`, so the count this returns — and the line
   * the one caller logs from it — says how many schedules this call actually
   * stopped, not how many it merely re-touched: unregistering an agent twice,
   * or unregistering one with no live schedules left, must not claim a second
   * round of pausing that did nothing.
   *
   * **No backfill for rows this method already wrote `enabled: false` onto,
   * before this fix.** Nothing on a row distinguishes "the person switched
   * this off" from "this writer switched it off for them" — both look like
   * `enabled: false`, same as any other row — so a sweep that flipped every
   * such row back to `true` would just as often overturn a real "no" as
   * repair a wrong one. That is a worse failure than the one being fixed: a
   * schedule the person is currently relying on staying off. A pre-existing
   * row is instead repaired the ordinary way, by touching it — switching it
   * off and on again, or any edit that re-syncs its file — which is already
   * true of every schedule this ships next to.
   *
   * @param agentId - The agent ULID whose linked tasks should be paused
   * @returns The number of tasks that were paused
   */
  disableTasksByAgentId(agentId: string): number {
    const now = new Date().toISOString();
    const result = this.db
      .update(pulseSchedules)
      .set({ status: 'paused', updatedAt: now })
      .where(and(eq(pulseSchedules.agentId, agentId), ne(pulseSchedules.status, 'paused')))
      .run();
    return result.changes;
  }

  /**
   * Resolve Pulse task origin for a batch of session ids, keyed by the id.
   * One indexed IN query over pulse_runs joined to pulse_schedules — O(1)
   * queries regardless of list size, used by the session-list origin
   * overlay (never called per-session).
   *
   * @param sessionIds - Session ids to look up; sessions with no matching run are absent from the returned map
   */
  resolveTaskOrigins(sessionIds: string[]): Map<string, { taskName: string }> {
    if (sessionIds.length === 0) return new Map();
    const rows = this.db
      .select({ sessionId: pulseRuns.sessionId, taskName: pulseSchedules.name })
      .from(pulseRuns)
      .innerJoin(pulseSchedules, eq(pulseRuns.scheduleId, pulseSchedules.id))
      .where(inArray(pulseRuns.sessionId, sessionIds))
      .all();
    const map = new Map<string, { taskName: string }>();
    for (const row of rows) {
      if (row.sessionId) map.set(row.sessionId, { taskName: row.taskName });
    }
    return map;
  }

  // === Reliability ===

  /**
   * Per-schedule reliability: success rate and p95 run duration, computed
   * over terminal runs only -- an in-flight run hasn't concluded yet, so it
   * can't count for or against a schedule (DOR-166).
   *
   * Service-layer query with no route/UI consumer yet: wire up an endpoint
   * when a surface needs "how slow and how reliable is this schedule".
   *
   * @param scheduleId - Restrict to one schedule. Omit for every schedule
   *   that has at least one terminal run.
   * @returns One row per schedule with at least one terminal run -- a
   *   schedule with none (never run, or only ever `running`) is simply
   *   absent, never a fabricated zero-filled row.
   */
  getScheduleReliability(scheduleId?: string): ScheduleReliability[] {
    // percentile_cont() ships in better-sqlite3 12.10+ (DOR-166); feature-detect
    // once and fall back to NULL instead of letting the query throw on an
    // older binary -- success rate must keep working either way.
    const p95Expr = hasPercentileSupport(this.db)
      ? sql<number | null>`percentile_cont(${pulseRuns.durationMs}, 0.95)`
      : sql<number | null>`NULL`;

    // Filter by the explicit terminal set, not `!= 'running'`, so this stays
    // in lockstep with TERMINAL_RUN_STATUSES (the run-lifecycle guard).
    // 'timeout' is appended because it exists only in the DB column's enum
    // (no writer produces it today, and the shared TaskRunStatus type omits
    // it): if such a row ever appears, it's a run that ended without
    // success, so it must count against the success rate rather than be
    // silently ignored.
    //
    // 'skipped' is excluded for the mirror-image reason: the agent never ran,
    // so the schedule neither succeeded nor failed. Counting a busy server
    // against the task's reliability would blame the task for the queue.
    const reliabilityTerminalStatuses = FINISHED_RUN_STATUSES.filter(
      (status) => status !== 'skipped'
    );
    const conditions = [inArray(pulseRuns.status, reliabilityTerminalStatuses)];
    if (scheduleId) {
      conditions.push(eq(pulseRuns.scheduleId, scheduleId));
    }

    return this.db
      .select({
        scheduleId: pulseRuns.scheduleId,
        totalRuns: count(),
        successRate: sql<number>`AVG(CASE WHEN ${pulseRuns.status} = 'completed' THEN 1.0 ELSE 0.0 END)`,
        p95DurationMs: p95Expr,
      })
      .from(pulseRuns)
      .where(and(...conditions))
      .groupBy(pulseRuns.scheduleId)
      .all();
  }

  // === File-based task sync ===

  /**
   * Upsert a task from a parsed SKILL.md file definition.
   *
   * @see {@link UpsertFromFileOptions} for what `options` decides.
   *
   * Looks up existing tasks by `filePath`. If found, updates in place.
   * If not found, inserts a new row with a fresh ULID.
   *
   * The file's declared `permissions` is resolved through
   * {@link resolveFilePermissionMode} rather than written straight in: this is
   * the primary create path for every task, and a file on disk is nobody's
   * approval. Read that function for what a file may and may not do to the mode.
   *
   * `options.source` decides whether the SECOND content gate applies. A write
   * from `discovery` — the watcher or the reconciler finding a file — can never
   * arm itself and parks at `pending_approval` until a person says otherwise
   * ({@link resolveFileArmStatus}). A write from `operator` is a person or an
   * install acting through DorkOS, and the act itself is the approval, so the
   * status is left exactly as it was. That is the default, because it is what
   * every caller here did before the gate existed.
   *
   * @param def - Parsed task definition from a SKILL.md file
   * @param agentId - Agent ID derived from directory location (optional)
   * @param options - Where the write came from, and what is wrong with the file
   * @returns The upserted Task
   */
  upsertFromFile(def: TaskDefinition, agentId?: string, options?: UpsertFromFileOptions): Task {
    const now = new Date().toISOString();
    // The schedule block is the only place scheduling lives since DOR-1486.
    // Until then this read went through a flattened copy of it that discovery
    // built for the legacy roots' benefit; those roots are gone and so is the
    // copy.
    const schedule = def.meta.schedule;
    const maxRuntimeMs = schedule['max-runtime'] ? parseDuration(schedule['max-runtime']) : null;

    const existing = this.db
      .select()
      .from(pulseSchedules)
      .where(eq(pulseSchedules.filePath, def.filePath))
      .get();

    const incomingCron = schedule.cron ?? '';
    // What a file on disk may do to this row, decided in one place so the
    // permission clamp and the arm gate cannot disagree — see
    // `file-sync-gates.ts` and `schedule-permission-clamp.ts`.
    const { permissionMode, arm, keepsRowEnabled, dropsTimingOverride, packageOwned } =
      this.fileGates.resolve(def, existing, options);

    if (existing) {
      this.db
        .update(pulseSchedules)
        .set({
          name: def.name,
          displayName: def.meta['display-name'] ?? null,
          description: def.meta.description ?? null,
          prompt: def.body,
          cron: incomingCron,
          timezone: schedule.timezone,
          agentId: agentId ?? null,
          // The file's switch, unless the row is the only place a person's own
          // can live: a schedule inside an installed package is one DorkOS
          // refuses to write, so switching it on is recorded on the row and
          // this sync must not copy `enabled: false` back over it (FB-26).
          // `file-sync-gates.ts` owns that condition.
          ...(keepsRowEnabled ? {} : { enabled: schedule.enabled }),
          sticky: schedule.sticky,
          maxRuntime: maxRuntimeMs,
          permissionMode,
          // The file is the source of truth for these three, like every other
          // scheduling column here — so a key REMOVED from the block clears the
          // row's override rather than leaving a stale one behind (DOR-1615).
          runtime: schedule.runtime ?? null,
          model: schedule.model ?? null,
          effort: schedule.effort ?? null,
          // The file is no longer a package's, so it is the one source of
          // timing again (DOR-2302, `FileSyncGates.dropsTimingOverride`).
          ...(dropsTimingOverride ? { cronOverride: null, timezoneOverride: null } : {}),
          // Who owns the file, kept so the next sync can see ownership lapse and
          // the app can show it (DOR-2272); `file-sync-gates.ts` decides what to
          // record while a release is still being written. A write that did not
          // ask leaves it as it was.
          ...(packageOwned !== undefined ? { packageOwned } : {}),
          // A `paused` row whose file is back is un-paused here, because
          // nothing else ever will: the scheduler requires `enabled` AND
          // `status === 'active'`, and restoring only `enabled` leaves a task
          // that looks live and never fires.
          //
          // Safe because `paused` is a server-owned signal, not a person's
          // choice. It is written only by this service — file gone
          // (`markRemovedByFilePath`), agent unregistered
          // (`disableTasksByAgentId`) — and `SettableTaskStatusSchema` keeps
          // the update API from setting it, precisely because a DB-only status
          // cannot survive this line. A person pausing a task sends
          // `enabled: false`, which lands in the file's frontmatter and is
          // re-read above, so their choice holds.
          // `pending_approval` is untouched: that gate is a person's to clear.
          //
          // Under the arm gate this un-pausing is the gate's call instead: a
          // returning file keeps its approval when the content key still
          // matches (a save is an unlink-and-recreate), and re-parks when it
          // does not.
          ...(arm
            ? {
                status: arm.status,
                ...fileProvenance(existing, arm),
                // Parking withdraws the grant, so the next sync has to ask again
                // rather than finding a key it left lying around.
                ...(arm.status === 'pending_approval'
                  ? {
                      approvedContentKey: null,
                      // Kept for the card's "what changed" (DOR-2323).
                      previousApprovalKey:
                        existing.approvedContentKey ?? existing.previousApprovalKey,
                    }
                  : { previousApprovalKey: null }),
              }
            : existing.status === 'paused'
              ? {
                  status: 'active' as const,
                  // ...and with a grant, because this branch ARMS the row. An
                  // operator write that un-pauses a schedule is the operator's
                  // approval of it, exactly as the insert branch treats a create;
                  // leaving the key null would put the row live and ungranted
                  // until the next sync noticed and parked it (DOR-1485 review,
                  // R2). Reachable through `shape-schedule-service` and through a
                  // route write over a path whose file had been deleted.
                  // What will RUN, a person's own timing included (DOR-2302).
                  approvedContentKey: effectiveContentKey({
                    ...existing,
                    ...fileSettingsOf(def),
                    prompt: def.body,
                    cron: incomingCron,
                    timezone: schedule.timezone,
                  }),
                  previousApprovalKey: null,
                }
              : {}),
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
        cron: incomingCron,
        timezone: schedule.timezone,
        agentId: agentId ?? null,
        enabled: schedule.enabled,
        sticky: schedule.sticky,
        maxRuntime: maxRuntimeMs,
        permissionMode,
        runtime: schedule.runtime ?? null,
        model: schedule.model ?? null,
        effort: schedule.effort ?? null,
        status: arm?.status ?? 'active',
        reason: arm?.reason ?? null,
        origin: arm ? 'file' : null,
        reasonSource: arm?.reason ? 'dorkos' : null,
        // An operator write IS the approval — the install or the route that
        // reached here is a person acting through DorkOS — so it arrives with a
        // grant. A discovered file never does; it has to be looked at first.
        approvedContentKey: arm
          ? null
          : scheduleContentKey({
              ...fileSettingsOf(def),
              prompt: def.body,
              cron: incomingCron,
              timezone: schedule.timezone,
            }),
        filePath: def.filePath,
        packageOwned: options?.packageOwned ?? null,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.getTask(id)!;
  }

  /**
   * Pause the one task whose file lived at `filePath`, because it is gone.
   *
   * Matched on the exact absolute path, never on the directory slug. Slugs are
   * only unique within one tasks directory, and DorkOS watches several at once
   * (the global one plus every registered agent's), so a slug match pauses a
   * live task in another project that happens to share the name — observed on
   * real data with two `flow-drain` tasks in different checkouts.
   *
   * The arm grant is deliberately LEFT ALONE here. A schedule whose file went
   * away has not been un-approved by anybody; if the same content comes back —
   * which is what an ordinary atomic-rename save looks like from the outside, and
   * what a package update does — the stored key still matches and the schedule
   * picks up where it left off. If different content comes back, the key does not
   * match and it parks. Neither outcome needs this method to have an opinion,
   * which is the point of storing the grant rather than inferring it from status:
   * an earlier round of this work had to special-case `pending_approval` here to
   * stop a pause laundering a missing approval, and that special case is now
   * unnecessary.
   *
   * `enabled` is left alone for the same reason. `paused` alone stops the clock
   * (the scheduler needs `enabled` AND `active`), and `enabled` is a person's
   * switch, not the server's. For most files the returning file's own switch is
   * copied back anyway, but a schedule shipped in an installed package keeps its
   * switch on the row (FB-26, `file-sync-gates.ts`), and a package update looks
   * like the file going away and coming back. Writing `false` here erased the
   * person's approval with nothing anywhere saying why.
   *
   * @param filePath - Absolute path to the SKILL.md that is no longer on disk
   * @returns The number of tasks marked as removed (0 or 1)
   */
  markRemovedByFilePath(filePath: string): number {
    // A file that came back is a fresh conflict, worth stating again.
    this.fileGates.forget(filePath);
    const now = new Date().toISOString();
    const result = this.db
      .update(pulseSchedules)
      .set({ status: 'paused', updatedAt: now })
      .where(eq(pulseSchedules.filePath, filePath))
      .run();
    return result.changes;
  }

  /**
   * Find the task defined by an exact SKILL.md path.
   *
   * Keyed on the full path, never a directory slug: a slug is unique only
   * within one tasks directory, and DorkOS watches the global one plus every
   * registered agent's, so a slug lookup silently returns an arbitrary one of
   * several matches.
   *
   * @param filePath - Absolute path to the task's SKILL.md
   * @returns The matching Task or null
   */
  getByFilePath(filePath: string): Task | null {
    const row = this.db
      .select()
      .from(pulseSchedules)
      .where(eq(pulseSchedules.filePath, filePath))
      .get();
    return row ? mapTaskRow(row) : null;
  }

  /** Close the database connection. No-op since the shared Db lifecycle is managed externally. */
  close(): void {
    logger.debug('[Tasks] TaskStore close() is a no-op — the db lifecycle is managed externally');
  }
}
