import { eq, desc, and, count, inArray, notInArray, lt, isNull, isNotNull, sql } from 'drizzle-orm';
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
import { FileSyncGates, type FileSyncSource } from './file-sync-gates.js';
import { scheduleContentKey, type IncomingTaskContent } from './schedule-permission-clamp.js';
import { mapTaskRow, mapRunRow } from './task-row-mappers.js';

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
 * The provenance columns a discovery sync may write to a row that ALREADY
 * EXISTS — which is usually none of them.
 *
 * Discovery re-reads every file every five minutes, and the legacy roots it
 * reads hold rows that discovery did not create: an agent's proposal, carrying
 * the case it made for itself and the session it was proposed from, and an
 * operator's own schedule, carrying nothing. Writing the arm gate's generic
 * story over either one destroys real provenance — an agent's reason replaced
 * by "DorkOS found this schedule in a file", an operator's row stamped
 * `origin: 'file'` in flat contradiction of what that column means (DOR-1485
 * review, B2).
 *
 * So:
 *
 * - `origin` is written only when the row was BORN from discovery. A row that
 *   arrived through a route is never re-labelled by a later sync of its file.
 * - `reason` is written only when discovery owns the row, or when the row has
 *   no story of its own to overwrite.
 * - `reasonSource` rides with any reason we DO write, marking it as DorkOS's
 *   own words. Without it the drift sentence on an operator's own schedule
 *   rendered on the approval card as an agent's quoted case — our words in
 *   somebody else's mouth.
 *
 * The arm STATUS is not conditional and is applied by the caller regardless:
 * that is the security property, and it holds for every row whatever wrote it.
 *
 * @param existing - The row being updated.
 * @param arm - What the arm gate decided.
 * @returns The provenance columns to include in the update, possibly none.
 */
function fileProvenance(
  existing: { origin: string | null; reason: string | null },
  arm: { reason: string | null }
): { reason?: string | null; origin?: 'file'; reasonSource?: 'dorkos' | null } {
  const source = arm.reason === null ? null : ('dorkos' as const);
  if (existing.origin === 'file')
    return { reason: arm.reason, origin: 'file', reasonSource: source };
  if (existing.reason === null) return { reason: arm.reason, reasonSource: source };
  return {};
}

/**
 * What {@link TaskStore.rekeyMigratedFile} did with one migrated row.
 *
 * `no-row` is not an error — a legacy file that never synced has no row, and a
 * re-run over an already-migrated file finds none at the old path either.
 */
export type RekeyOutcome = 'rekeyed' | 'reparked' | 'moved' | 'no-row';

/**
 * Why a migrated schedule is waiting for a person again: its file no longer says
 * what the row it was approved as says.
 *
 * Only reachable when the file was edited while DorkOS was not running, since
 * the migration itself never changes a schedule's prompt or cron.
 */
const DRIFTED_DURING_MIGRATION_REASON =
  'This schedule’s file changed since it was last approved, so it is waiting for you again. ' +
  'Read what it does now, then approve it or delete it.';

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

  constructor(db: Db) {
    this.db = db;
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
        status: 'active',
        // An operator create is itself the approval, so the row arrives armed.
        // A caller that must not arm anything — an agent — is parked by the
        // route straight after, and that park withdraws this through
        // `updateTask`.
        approvedContentKey: scheduleContentKey({
          prompt: input.prompt,
          cron: input.cron ?? '',
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
    // `''`, never `null` — the column is NOT NULL and an empty cron is what
    // "on demand" means in it, the same way {@link createTask} and
    // {@link upsertFromFile} both already write it (`registerTask` reads a
    // falsy cron as "do not schedule this"). A literal null threw a NOT NULL
    // constraint error straight out of this method, and the cockpit's edit form
    // sends exactly that on every save of a task with no cron
    // (`cron: cronTrimmed || null` in `TaskFormInner.tsx`) — so editing an
    // on-demand task's prompt failed, AFTER its file had already been rewritten.
    if (input.cron !== undefined) updates.cron = input.cron ?? '';
    if (input.timezone !== undefined) updates.timezone = input.timezone ?? 'UTC';
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.sticky !== undefined) updates.sticky = input.sticky;
    if (input.maxRuntime !== undefined) {
      updates.maxRuntime =
        typeof input.maxRuntime === 'string' ? parseDuration(input.maxRuntime) : null;
    }
    if (input.permissionMode !== undefined) updates.permissionMode = input.permissionMode;
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
    if (input.status === 'active') this.recordApproval(id);
    else if (input.status !== undefined) this.withdrawApproval(id);

    return this.getTask(id);
  }

  /**
   * Record that a person has approved this schedule's CURRENT content.
   *
   * The arm grant (`pulse_schedules.approved_content_key`). Stored positively so
   * that no amount of status-writing elsewhere can fabricate it — see
   * {@link resolveFileArmStatus} for the two writers that used to.
   *
   * @param id - The schedule a person just armed.
   */
  recordApproval(id: string): void {
    const row = this.db
      .select({ prompt: pulseSchedules.prompt, cron: pulseSchedules.cron })
      .from(pulseSchedules)
      .where(eq(pulseSchedules.id, id))
      .get();
    if (!row) return;
    this.db
      .update(pulseSchedules)
      .set({ approvedContentKey: scheduleContentKey(row) })
      .where(eq(pulseSchedules.id, id))
      .run();
  }

  /**
   * Drop the arm grant, because this schedule is no longer approved.
   *
   * Called whenever a row leaves `active` through the API — parking it, pausing
   * it — so an approval can never outlive the decision that made it.
   *
   * @param id - The schedule to withdraw approval from.
   */
  withdrawApproval(id: string): void {
    this.db
      .update(pulseSchedules)
      .set({ approvedContentKey: null })
      .where(eq(pulseSchedules.id, id))
      .run();
  }

  /**
   * Move a row onto its file's new home, keeping any approval it holds — the DB
   * half of the legacy migration (DOR-1486).
   *
   * One transaction, because the two writes are one fact: a row whose path moved
   * without its grant re-keying is a schedule an operator approved that quietly
   * asks to be approved again, and a grant re-keyed without the path moving is a
   * grant for a file nothing reads. Either half alone is worse than neither.
   *
   * ## Why the key is compared against the ROW, not just taken from the file
   *
   * The migration rewrites frontmatter and never touches the body or the cron
   * line, so the content key it produces is the key the row already had. That is
   * the ordinary case, and it is why an approved schedule survives the upgrade
   * without anyone re-approving it.
   *
   * The case worth writing code for is the other one: the file was edited while
   * the server was down. Then the row's `(prompt, cron)` and the file's are
   * DIFFERENT pieces of work, and stamping the file's key onto an active row
   * would hand a person's approval to content nobody has read — grant without
   * review, the one outcome this whole gate exists to prevent. So the two keys
   * are compared, and a mismatch parks the row instead of re-keying it. That is
   * the same answer the first sync after boot would reach on its own; reaching it
   * here just means the schedule never fires the unread content in between.
   *
   * A row that is not `active` migrates exactly as it is — parked stays parked,
   * paused stays paused, and whatever grant it holds is left alone, because
   * moving a file is not a decision about it. Provenance follows the same rules
   * every discovery write follows ({@link fileProvenance}): DorkOS never
   * overwrites an agent's proposal reason with its own prose.
   *
   * @param from - The path the row is keyed on now.
   * @param to - The path its file lives at after the move, symlinks resolved.
   * @param rewritten - The migrated file's material content.
   * @param park - A reason to park the row regardless (the name-collision case),
   *   or `null` to let the comparison above decide.
   * @returns What happened, for the caller's log and counters.
   */
  rekeyMigratedFile(
    from: string,
    to: string,
    rewritten: IncomingTaskContent,
    park: string | null = null
  ): RekeyOutcome {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(pulseSchedules)
        .where(eq(pulseSchedules.filePath, from))
        .get();
      // No row is an ordinary outcome, not a failure: a legacy file DorkOS never
      // managed to sync has none, and a re-run after a crash finds the row
      // already moved.
      if (!existing) return 'no-row';

      const now = new Date().toISOString();
      const fileKey = scheduleContentKey(rewritten);
      const agrees =
        scheduleContentKey({ prompt: existing.prompt, cron: existing.cron }) === fileKey;

      if (existing.status === 'active' && park === null && agrees) {
        tx.update(pulseSchedules)
          .set({ filePath: to, approvedContentKey: fileKey, updatedAt: now })
          .where(eq(pulseSchedules.id, existing.id))
          .run();
        return 'rekeyed';
      }

      if (existing.status === 'active') {
        const reason = park ?? DRIFTED_DURING_MIGRATION_REASON;
        tx.update(pulseSchedules)
          .set({
            filePath: to,
            status: 'pending_approval',
            approvedContentKey: null,
            ...fileProvenance(existing, { reason }),
            updatedAt: now,
          })
          .where(eq(pulseSchedules.id, existing.id))
          .run();
        return 'reparked';
      }

      tx.update(pulseSchedules)
        .set({ filePath: to, updatedAt: now })
        .where(eq(pulseSchedules.id, existing.id))
        .run();
      return 'moved';
    });
  }

  /**
   * Give every already-live schedule a grant for the content it is already
   * running (DOR-1485).
   *
   * Runs once at boot, before any watcher starts. Every alpha user has `active`
   * rows that predate the grant column, and without this the first sync of each
   * would find no key, park it, and confront them with a list of schedules they
   * approved months ago. The row being `active` before this build existed IS the
   * historical approval; this writes it down in the form the gate now reads.
   *
   * Idempotent and cheap: it only touches rows whose key is NULL, so a second
   * boot matches nothing. Deliberately narrow, too — a `paused` or
   * `pending_approval` row is not evidence of anything and gets no key, which is
   * exactly the laundering the positive grant exists to stop.
   *
   * The keys are computed in JS, one row at a time, rather than by a single
   * `UPDATE ... json_array(prompt, cron)`. SQLite's JSON writer and
   * `JSON.stringify` agree on ordinary text and are not guaranteed to agree on
   * escaping — a newline or an emoji in a prompt would be enough — and a key
   * that differs by one byte from the one the gate computes is a grant that
   * silently never matches. There are tens of these rows, not thousands.
   *
   * @returns How many rows were back-filled.
   */
  backfillApprovalGrants(): number {
    const rows = this.db
      .select({ id: pulseSchedules.id, prompt: pulseSchedules.prompt, cron: pulseSchedules.cron })
      .from(pulseSchedules)
      .where(and(eq(pulseSchedules.status, 'active'), isNull(pulseSchedules.approvedContentKey)))
      .all();

    for (const row of rows) {
      this.db
        .update(pulseSchedules)
        .set({ approvedContentKey: scheduleContentKey(row) })
        .where(eq(pulseSchedules.id, row.id))
        .run();
    }
    return rows.length;
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
   * @param taskId - The task whose latest session to resume.
   * @returns The real SDK session id to resume, or null when none has run yet.
   */
  latestStickySessionId(taskId: string): string | null {
    const row = this.db
      .select({ sessionId: pulseRuns.sessionId })
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
    return row?.sessionId ?? null;
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
    const { permissionMode, arm } = this.fileGates.resolve(def, existing, options);

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
          enabled: schedule.enabled,
          sticky: schedule.sticky,
          maxRuntime: maxRuntimeMs,
          permissionMode,
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
                ...(arm.status === 'pending_approval' ? { approvedContentKey: null } : {}),
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
                  approvedContentKey: scheduleContentKey({
                    prompt: def.body,
                    cron: incomingCron,
                  }),
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
        status: arm?.status ?? 'active',
        reason: arm?.reason ?? null,
        origin: arm ? 'file' : null,
        reasonSource: arm?.reason ? 'dorkos' : null,
        // An operator write IS the approval — the install or the route that
        // reached here is a person acting through DorkOS — so it arrives with a
        // grant. A discovered file never does; it has to be looked at first.
        approvedContentKey: arm
          ? null
          : scheduleContentKey({ prompt: def.body, cron: incomingCron }),
        filePath: def.filePath,
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
   * @param filePath - Absolute path to the SKILL.md that is no longer on disk
   * @returns The number of tasks marked as removed (0 or 1)
   */
  markRemovedByFilePath(filePath: string): number {
    // A file that came back is a fresh conflict, worth stating again.
    this.fileGates.forget(filePath);
    const now = new Date().toISOString();
    const result = this.db
      .update(pulseSchedules)
      .set({ enabled: false, status: 'paused', updatedAt: now })
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
