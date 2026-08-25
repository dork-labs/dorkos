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
import { and, eq, a2aTasks, type Db } from '@dorkos/db';

/** The status values accepted by the a2a_tasks Drizzle column. */
type DbStatus = typeof a2aTasks.$inferInsert.status;

/** Default page size for {@link SqliteTaskStore.list}, per the A2A spec. */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for {@link SqliteTaskStore.list}, per the A2A spec. */
const MAX_PAGE_SIZE = 100;

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
   * Filters on `contextId` and `status` are applied in SQL; `pageToken` is the
   * offset of the next row, as a decimal string.
   *
   * @param params - Filtering and pagination parameters.
   * @param _context - The call context; unused, see {@link SqliteTaskStore.load}.
   */
  async list(params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
    const pageSize = clampPageSize(params.pageSize);
    const offset = parseOffset(params.pageToken);

    const filters = [
      params.contextId.length > 0 ? eq(a2aTasks.contextId, params.contextId) : undefined,
      params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED
        ? eq(a2aTasks.status, taskStateToDbStatus(params.status))
        : undefined,
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
      tasks: page.map(rowToTask),
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
 * Read a page token as a row offset, treating anything unparseable as the start.
 *
 * @param token - The caller's `pageToken`.
 */
function parseOffset(token: string | undefined): number {
  if (token === undefined || token.length === 0) return 0;
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Convert a database row into an A2A Task object. */
function rowToTask(row: typeof a2aTasks.$inferSelect): Task {
  return {
    id: row.id,
    contextId: row.contextId,
    status: {
      state: dbStatusToTaskState(row.status),
      message: undefined,
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
