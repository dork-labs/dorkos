/**
 * The app's scheduled-task reads (DOR-4978), as capabilities the mount serves on
 * the paths the app always used (ADR 261123-170830):
 *
 * - `tasks.view_list`: `GET /api/tasks`: every schedule, with its next runs.
 * - `tasks.view_runs`: `GET /api/tasks/runs`: runs, newest first.
 * - `tasks.view_run`: `GET /api/tasks/runs/{id}`: one run.
 *
 * ## Who may read what
 *
 * Anyone in the space, agents included, in the Tasks area like the agents' own
 * `tasks_list` and `tasks_get_run_history`. What each reader gets:
 *
 * - The list gives a pending schedule's folder rules and where its run would
 *   land only to a caller that clears the agent bar (`context.request.clearsAgentBar`),
 *   as the hand route did: agent config reads withhold them too. A call with
 *   no HTTP request never clears it.
 * - Runs, to an agent, are only its own schedules' and global ones', as
 *   `tasks_get_run_history` answers in a chat (DOR-4600): a run's summary is
 *   that run's own words, and its chat is another agent's work. An agent whose
 *   token DorkOS can't resolve reads global schedules' runs only. A run outside
 *   that reach answers as if it were not there. A turn whose reads are narrowed
 *   gets no summaries. Unlike `tasks_get_run_history`, the HTTP read has no
 *   exception for a Full-autonomy turn (`readsOthers`): an HTTP call carries no turn.
 * - The list itself shows an agent every schedule, as the hand route and
 *   `tasks_list` always have.
 *
 * @module services/tasks/view/task-view-capabilities
 */
import { z } from 'zod';
import {
  ListTaskRunsQuerySchema,
  TaskRunSchema,
  TaskSchema,
  type Task,
  type TaskRun,
} from '@dorkos/shared/schemas';
import {
  defineCapability,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';

/** What the task reads ask, over the running Tasks service (`routes/task-view-reader.ts`). */
export interface TaskViewReader {
  /**
   * Every schedule, presented as the app reads it.
   *
   * @param person - Whether the caller clears the agent bar, which adds each
   *   pending schedule's folder rules and where its run would land.
   */
  listTasks(person: boolean): Promise<Task[]>;
  /** Each schedule's id and the agent it belongs to, or `null` for a global one. */
  scheduleOwners(): ReadonlyMap<string, string | null>;
  /** Runs, newest first. */
  listRuns(filter: {
    taskId?: string;
    taskIds?: readonly string[];
    status?: string;
    limit: number;
    offset: number;
  }): TaskRun[];
  /** One run, or `null`. */
  getRun(id: string): TaskRun | null;
  /** The Mesh id of the agent whose home is `agentPath`, or `undefined`. */
  agentIdOfHome(agentPath: string): string | undefined;
}

/** Set when Tasks starts; absent, the reads say Tasks is not running. */
let reader: TaskViewReader | undefined;

/**
 * Teach the task reads where to read from.
 *
 * @param next - The reader, or `undefined` when Tasks stops.
 */
export function setTaskViewReader(next: TaskViewReader | undefined): void {
  reader = next;
}

/** The reader, or the refusal a server without Tasks answers. */
function readerOrRefuse(): TaskViewReader {
  if (!reader) {
    throw new CapabilityToolError({
      code: 'TASKS_UNAVAILABLE',
      error: 'Scheduled tasks are not running on this server.',
    });
  }
  return reader;
}

/** What a request naming a run that is not there, or not the caller's to read, is told. */
const RUN_NOT_FOUND = { code: 'TASK_RUN_NOT_FOUND', error: 'No run has that id.' } as const;

/**
 * Which schedules' runs the caller may read: every one (`undefined`) for anyone
 * but an agent, else the calling agent's own and the global ones.
 */
function readableSchedules(
  view: TaskViewReader,
  context: CapabilityHandlerContext
): ReadonlySet<string> | undefined {
  if (!context.identity && !context.agentIdentityPresented) return undefined;
  const caller = context.identity ? view.agentIdOfHome(context.identity.agentPath) : undefined;
  // Only schedules that still exist: an agent never reads a deleted schedule's runs, which is
  // stricter than `tasks_get_run_history` (it allows an unknown schedule) on purpose.
  const readable = new Set<string>();
  for (const [id, owner] of view.scheduleOwners()) {
    if (owner === null || (caller !== undefined && owner === caller)) readable.add(id);
  }
  return readable;
}

/** A run as this caller reads it: no summary on a turn whose reads are narrowed. */
function asRead(run: TaskRun, context: CapabilityHandlerContext): TaskRun {
  if (!context.narrowedReads) return run;
  const { outputSummary: _left, ...rest } = run;
  return { ...rest, outputSummary: null };
}

/** Why these reads sit in the Tasks area. */
const AREA_NOTE = 'reads schedules and runs, as the agents’ own tasks_ tools do';

/** The app's task reads; served whether or not Tasks runs, which they then say. */
export const taskViewDomain: CapabilityDomain = {
  name: 'tasks',
  capabilities: [
    defineCapability({
      id: 'tasks.view_list',
      title: 'List scheduled tasks',
      description:
        'Every scheduled task, with its next run and, while one waits for approval, a preview ' +
        'of the few after it. Agents usually use `tasks_list`.',
      tier: 'observe',
      area: 'tasks',
      areaNote: AREA_NOTE,
      input: z.object({}),
      output: z.array(TaskSchema),
      surfaces: { http: { method: 'get', path: '/api/tasks' } },
      invoke: async (_deps, _input, context) =>
        readerOrRefuse().listTasks(context.request?.clearsAgentBar === true),
    }),
    defineCapability({
      id: 'tasks.view_runs',
      title: 'List scheduled task runs',
      description:
        'Runs of scheduled tasks, newest first, by schedule or status. An agent reads only its ' +
        'own schedules’ runs and global ones’. Agents usually use `tasks_get_run_history`.',
      tier: 'observe',
      area: 'tasks',
      areaNote: AREA_NOTE,
      input: z.object(ListTaskRunsQuerySchema.shape),
      output: z.array(TaskRunSchema),
      surfaces: { http: { method: 'get', path: '/api/tasks/runs' } },
      invoke: async (_deps, { scheduleId, status, limit, offset }, context) => {
        const view = readerOrRefuse();
        const readable = readableSchedules(view, context);
        if (readable && scheduleId !== undefined && !readable.has(scheduleId)) return [];
        if (readable && readable.size === 0) return [];
        const runs = view.listRuns({
          ...(scheduleId !== undefined ? { taskId: scheduleId } : {}),
          ...(readable ? { taskIds: [...readable] } : {}),
          ...(status !== undefined ? { status } : {}),
          limit,
          offset,
        });
        return runs.map((run) => asRead(run, context));
      },
    }),
    defineCapability({
      id: 'tasks.view_run',
      title: 'Open a scheduled task run',
      description: 'One run of a scheduled task. An agent reads only its own and global ones.',
      tier: 'observe',
      area: 'tasks',
      areaNote: AREA_NOTE,
      input: z.object({ id: z.string().min(1).describe('The run.') }),
      output: TaskRunSchema,
      surfaces: { http: { method: 'get', path: '/api/tasks/runs/{id}' } },
      invoke: async (_deps, { id }, context) => {
        const view = readerOrRefuse();
        const run = view.getRun(id);
        const readable = readableSchedules(view, context);
        if (!run || (readable && !readable.has(run.scheduleId))) {
          throw new CapabilityToolError(RUN_NOT_FOUND);
        }
        return asRead(run, context);
      },
    }),
  ],
};
