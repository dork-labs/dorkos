/**
 * SQLite-backed TaskStore for A2A task persistence.
 *
 * Implements the `@a2a-js/sdk` `TaskStore` interface using Drizzle ORM
 * against the `a2a_tasks` table. History, artifacts, and metadata are
 * serialized as JSON text columns. Upsert semantics ensure idempotent
 * saves — saving the same task ID twice updates the existing row.
 *
 * The `status` column stores the A2A **v0.3** spelling of each state
 * (`'input-required'`, not `TASK_STATE_INPUT_REQUIRED`). A2A v1.0 models
 * `TaskState` as a numeric protobuf enum, whose ordinals are a wire detail
 * with no business being a durable value — and keeping the readable strings
 * means the rows written before the v1.0 upgrade are still the rows we read
 * today, with no migration. {@link taskStateToDbStatus} and
 * {@link dbStatusToTaskState} are the only places the two spellings meet.
 *
 * @module a2a-gateway/task-store
 */
import { TaskState, type Task } from '@a2a-js/sdk';
import type { ListTasksRequest, ListTasksResponse } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import { and, eq, gte, a2aTasks, type Db } from '@dorkos/db';

/** The status values accepted by the a2a_tasks Drizzle column. */
type DbStatus = typeof a2aTasks.$inferInsert.status;

/** Default page size for {@link SqliteTaskStore.list}, per the A2A spec. */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for {@link SqliteTaskStore.list}, per the A2A spec. */
const MAX_PAGE_SIZE = 100;

/**
 * The `ServerCallContext.state` key naming the agent a request is bound to.
 *
 * Set by the per-agent Express endpoint (`/a2a/agents/:id`) and read by
 * {@link SqliteTaskStore.list}. It is the only way the store can tell the two
 * endpoints apart: the SDK hands it one `ListTasksRequest`, and that request
 * has no field for "which agent did the caller address this to".
 */
export const BOUND_AGENT_STATE_KEY = 'dorkos.boundAgentId';

/** Every A2A task state, paired with the string the `status` column stores. */
const DB_STATUS_BY_STATE: ReadonlyMap<TaskState, DbStatus> = new Map([
  [TaskState.TASK_STATE_SUBMITTED, 'submitted'],
  [TaskState.TASK_STATE_WORKING, 'working'],
  [TaskState.TASK_STATE_INPUT_REQUIRED, 'input-required'],
  [TaskState.TASK_STATE_AUTH_REQUIRED, 'auth-required'],
  [TaskState.TASK_STATE_COMPLETED, 'completed'],
  [TaskState.TASK_STATE_CANCELED, 'canceled'],
  [TaskState.TASK_STATE_FAILED, 'failed'],
  [TaskState.TASK_STATE_REJECTED, 'rejected'],
] as const);

/** The reverse of {@link DB_STATUS_BY_STATE}. */
const STATE_BY_DB_STATUS: ReadonlyMap<string, TaskState> = new Map(
  [...DB_STATUS_BY_STATE].map(([state, status]) => [status as string, state])
);

/**
 * Map an A2A task state to the string the `status` column stores.
 *
 * Unspecified and unrecognized states store as `'unknown'` — a task whose
 * state we cannot name is exactly what that value is for.
 *
 * @param state - The A2A task state.
 */
export function taskStateToDbStatus(state: TaskState | undefined): DbStatus {
  return (state !== undefined ? DB_STATUS_BY_STATE.get(state) : undefined) ?? 'unknown';
}

/**
 * Map a stored `status` string back to an A2A task state.
 *
 * @param status - The value read from the `status` column.
 */
export function dbStatusToTaskState(status: string): TaskState {
  return STATE_BY_DB_STATUS.get(status) ?? TaskState.TASK_STATE_UNSPECIFIED;
}

/** SQLite-backed TaskStore for A2A task persistence. */
export class SqliteTaskStore implements TaskStore {
  constructor(private readonly db: Db) {}

  /**
   * Load a task by ID, returning `undefined` if not found.
   *
   * @param taskId - The task to load.
   * @param _context - The call context. Unused: this store is single-tenant,
   *   backed by one operator's own SQLite file, so there is no tenant or owner
   *   to scope by — every caller of this gateway sees the same tasks.
   */
  async load(taskId: string, _context: ServerCallContext): Promise<Task | undefined> {
    const row = this.db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId)).get();
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Save a task, upserting if the ID already exists.
   *
   * @param task - The task to persist.
   * @param _context - The call context; unused, see {@link SqliteTaskStore.load}.
   */
  async save(task: Task, _context: ServerCallContext): Promise<void> {
    const now = new Date().toISOString();
    const status = taskStateToDbStatus(task.status?.state);
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

  /**
   * List stored tasks, newest first, with optional filtering and pagination.
   *
   * Every filter the A2A `ListTasks` request can carry is honored here, and
   * that is deliberate: the SDK validates these parameters and so advertises
   * them as supported. Accepting one and ignoring it would answer with the
   * wrong tasks rather than with an error — the worst of the two failures,
   * because nothing on the wire says the filter did not happen.
   *
   * `contextId`, `status` and `statusTimestampAfter` are applied in SQL;
   * `pageToken` is the offset of the next row, as a decimal string.
   *
   * One filter comes from the endpoint rather than the request: a call to
   * `/a2a/agents/:id` is bound to that agent, and the listing is scoped to its
   * tasks (see {@link BOUND_AGENT_STATE_KEY}). Everything else on that endpoint
   * is about the one agent named in the URL, and a caller who asked about it
   * has no business being handed every other agent's message history. The
   * fleet endpoint carries no binding and still surveys the whole fleet.
   *
   * @param params - Filtering and pagination parameters.
   * @param context - The call context. Read for the bound agent only; this
   *   store is otherwise single-tenant, see {@link SqliteTaskStore.load}.
   */
  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const pageSize = clampPageSize(params.pageSize);
    const offset = parseOffset(params.pageToken);
    const boundAgentId = readBoundAgentId(context);

    // `updatedAt` IS the status timestamp — `rowToTask` reads the task's
    // `status.timestamp` from this same column, so filtering on it answers the
    // question the caller actually asked.
    const after = normalizeTimestamp(params.statusTimestampAfter);

    const filters = [
      boundAgentId !== undefined ? eq(a2aTasks.agentId, boundAgentId) : undefined,
      params.contextId.length > 0 ? eq(a2aTasks.contextId, params.contextId) : undefined,
      params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED
        ? eq(a2aTasks.status, taskStateToDbStatus(params.status))
        : undefined,
      after !== undefined ? gte(a2aTasks.updatedAt, after) : undefined,
    ].filter((f) => f !== undefined);
    const where = filters.length > 0 ? and(...filters) : undefined;

    const rows = this.db
      .select()
      .from(a2aTasks)
      .where(where)
      .orderBy(a2aTasks.updatedAt)
      .all()
      .reverse();

    const page = rows.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;

    return {
      // Artifacts are opt-in, per the A2A spec's own default: a listing is a
      // survey, and shipping every task's full output by default is how a
      // page of results becomes megabytes.
      tasks: page.map((row) => rowToTask(row, params.includeArtifacts === true)),
      nextPageToken: nextOffset < rows.length ? String(nextOffset) : '',
      pageSize,
      totalSize: rows.length,
    };
  }
}

/**
 * Clamp a requested page size into the range the A2A spec allows.
 *
 * @param requested - The caller's `pageSize`, if any.
 */
function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

/**
 * Normalize an ISO 8601 timestamp filter into the exact spelling the
 * `updated_at` column stores, or `undefined` when there is nothing to filter on.
 *
 * The column holds `Date#toISOString` output, which compares correctly as text
 * only against another string in that same shape. A caller is free to send
 * `2026-08-25T10:00:00+02:00`, which sorts nowhere near its own UTC instant —
 * so the bound is parsed and re-rendered rather than compared as it arrived.
 * An unparseable value filters nothing, matching how the other filters treat
 * an absent field.
 *
 * @param value - The caller's `statusTimestampAfter`.
 */
function normalizeTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Read the agent a request is bound to out of the call context.
 *
 * Absent on the fleet endpoint, which is what makes that listing fleet-wide.
 *
 * @param context - The call context the SDK built for this request.
 */
function readBoundAgentId(context: ServerCallContext): string | undefined {
  const value = context.state.get(BOUND_AGENT_STATE_KEY);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a page token as a row offset, treating anything unparseable as the start.
 *
 * @param token - The caller's `pageToken`.
 */
function parseOffset(token: string | undefined): number {
  if (token === undefined || token.length === 0) return 0;
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Convert a database row into an A2A Task object.
 *
 * @param row - The stored row.
 * @param includeArtifacts - Whether to carry the task's artifacts. Listings
 *   default this off (see {@link SqliteTaskStore.list}); a direct `load` always
 *   passes `true`, because asking for one task by id is asking for all of it.
 */
function rowToTask(row: typeof a2aTasks.$inferSelect, includeArtifacts = true): Task {
  return {
    id: row.id,
    contextId: row.contextId,
    status: {
      state: dbStatusToTaskState(row.status),
      message: undefined,
      timestamp: row.updatedAt,
    },
    history: JSON.parse(row.historyJson),
    artifacts: includeArtifacts ? JSON.parse(row.artifactsJson) : [],
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
