/**
 * Tasks scheduler Transport methods factory.
 *
 * @module shared/lib/transport/task-methods
 */
import type {
  Task,
  TaskRun,
  CreateTaskInput,
  UpdateTaskRequest,
  ListTaskRunsQuery,
  TaskTemplate,
  CancelTaskRunResponse,
} from '@dorkos/shared/types';
import { fetchJSON, buildQueryString } from './http-client';

/** Create all Tasks scheduler methods bound to a base URL. */
export function createTasksMethods(baseUrl: string) {
  return {
    listTasks(): Promise<Task[]> {
      return fetchJSON<Task[]>(baseUrl, '/tasks');
    },

    createTask(opts: CreateTaskInput): Promise<Task> {
      return fetchJSON<Task>(baseUrl, '/tasks', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
    },

    updateTask(id: string, opts: UpdateTaskRequest): Promise<Task> {
      return fetchJSON<Task>(baseUrl, `/tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(opts),
      });
    },

    deleteTask(id: string): Promise<{ success: boolean }> {
      return fetchJSON<{ success: boolean }>(baseUrl, `/tasks/${id}`, {
        method: 'DELETE',
      });
    },

    triggerTask(id: string): Promise<{ runId: string }> {
      return fetchJSON<{ runId: string }>(baseUrl, `/tasks/${id}/trigger`, {
        method: 'POST',
      });
    },

    listTaskRuns(opts?: Partial<ListTaskRunsQuery>): Promise<TaskRun[]> {
      const qs = buildQueryString({
        scheduleId: opts?.scheduleId,
        status: opts?.status,
        limit: opts?.limit,
        offset: opts?.offset,
      });
      return fetchJSON<TaskRun[]>(baseUrl, `/tasks/runs${qs}`);
    },

    getTaskRun(id: string): Promise<TaskRun> {
      return fetchJSON<TaskRun>(baseUrl, `/tasks/runs/${id}`);
    },

    cancelTaskRun(id: string): Promise<CancelTaskRunResponse> {
      return fetchJSON<CancelTaskRunResponse>(baseUrl, `/tasks/runs/${id}/cancel`, {
        method: 'POST',
      });
    },

    getTaskTemplates(): Promise<TaskTemplate[]> {
      return fetchJSON<TaskTemplate[]>(baseUrl, '/tasks/templates');
    },
  };
}
