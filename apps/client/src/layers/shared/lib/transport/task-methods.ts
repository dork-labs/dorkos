/**
 * Tasks scheduler Transport methods factory, through the generated API client
 * where a call is plain JSON (DOR-5473).
 *
 * @module shared/lib/transport/task-methods
 */
import type {
  Task,
  TaskRun,
  CreateTaskInput,
  UpdateTaskRequest,
  TriggerTaskRequest,
  ListTaskRunsQuery,
  TaskTemplate,
  CancelTaskRunResponse,
} from '@dorkos/shared/types';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/** Create all Tasks scheduler methods bound to a base URL. */
export function createTasksMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  // The document also lists the capability mount's 202 approval answer, which a
  // person's own call never gets; the casts keep today's types.
  return {
    async listTasks(): Promise<Task[]> {
      return (await api.call('tasks.view_list', {})) as Task[];
    },

    // Stays hand-written: the generated body makes the defaulted `enabled`
    // required, where the route lets it out (DOR-5473).
    createTask(opts: CreateTaskInput): Promise<Task> {
      return fetchJSON<Task>(baseUrl, '/tasks', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
    },

    // Stays hand-written: the generated body drops the `null` that clears a
    // schedule's effort (DOR-5473).
    updateTask(id: string, opts: UpdateTaskRequest): Promise<Task> {
      return fetchJSON<Task>(baseUrl, `/tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(opts),
      });
    },

    async deleteTask(id: string): Promise<{ success: boolean }> {
      return (await api.call('tasks.delete', { path: { id } })) as { success: boolean };
    },

    // Stays hand-written: the document gives `tasks.undoAgentMode` no body, but
    // the route reads `notificationId` from one (DOR-5473).
    undoAgentTaskMode(taskId: string, notificationId: string): Promise<Task> {
      return fetchJSON<Task>(baseUrl, `/tasks/${taskId}/undo-agent-mode`, {
        method: 'POST',
        body: JSON.stringify({ notificationId }),
      });
    },

    async approveTaskFile(taskId: string, capAt: string | null, hash: string): Promise<Task> {
      return (await api.call('tasks.approveFile', {
        path: { id: taskId },
        body: capAt === null ? { hash } : { capAt, hash },
      })) as Task;
    },

    // Stays hand-written: a run with no permission mode sends no body, where the
    // client sends `{}`; waits for batch 3's no-body client (DOR-5473).
    triggerTask(id: string, opts?: TriggerTaskRequest): Promise<{ runId: string }> {
      return fetchJSON<{ runId: string }>(baseUrl, `/tasks/${id}/trigger`, {
        method: 'POST',
        ...(opts?.permissionMode ? { body: JSON.stringify(opts) } : {}),
      });
    },

    async listTaskRuns(opts?: Partial<ListTaskRunsQuery>): Promise<TaskRun[]> {
      return (await api.call('tasks.view_runs', {
        query: {
          scheduleId: opts?.scheduleId,
          status: opts?.status,
          limit: opts?.limit,
          offset: opts?.offset,
        },
      })) as TaskRun[];
    },

    async getTaskRun(id: string): Promise<TaskRun> {
      return (await api.call('tasks.view_run', { path: { id } })) as TaskRun;
    },

    // Stays hand-written: waits for batch 3's no-body client (DOR-5473).
    cancelTaskRun(id: string): Promise<CancelTaskRunResponse> {
      return fetchJSON<CancelTaskRunResponse>(baseUrl, `/tasks/runs/${id}/cancel`, {
        method: 'POST',
      });
    },

    // Stays hand-written: `GET /api/tasks/templates` has no operationId (DOR-5473).
    getTaskTemplates(): Promise<TaskTemplate[]> {
      return fetchJSON<TaskTemplate[]>(baseUrl, '/tasks/templates');
    },
  };
}
