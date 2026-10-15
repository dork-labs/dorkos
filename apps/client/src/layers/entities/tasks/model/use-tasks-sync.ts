import { useQueryClient } from '@tanstack/react-query';
import { useEventSubscription } from '@/layers/shared/model';
import { TASKS_KEY } from './use-tasks';
import { TASK_RUNS_KEY } from './use-task-runs';

/**
 * Keep the Tasks list, and the runs that hang off it, fresh across clients and tabs.
 *
 * The server broadcasts `tasks_changed` on the unified `/api/events` stream
 * whenever a schedule is created, updated or deleted through the routes or the
 * MCP tools — including a schedule an agent proposes through the
 * `tasks_create` MCP tool, which always parks at `pending_approval`
 * (DOR-1380). Without this, that parked schedule was invisible until the next
 * full page reload; this hook invalidates the shared tasks query so it
 * appears the moment the agent creates it.
 *
 * `exact: true` matters here: `['tasks']` is a PREFIX of the chat panel's
 * per-session todo query, `['tasks', sessionId, cwd]`
 * (`features/chat/model/use-task-state.ts`). TanStack Query matches query
 * keys by prefix unless told otherwise, so without `exact` this would also
 * invalidate — and reset — a session's streamed todo list mid-turn every time
 * any schedule anywhere changed.
 */
export function useTasksSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('tasks_changed', () => {
    void queryClient.invalidateQueries({ queryKey: [...TASKS_KEY], exact: true });
  });
  // A run recorded failed, or a finished run's report growing late (DOR-2717):
  // the always-mounted Schedules tab reads the newest runs and polls them only
  // slowly while nothing runs, so it hears about these here (DOR-2820).
  const refreshRuns = () => {
    void queryClient.invalidateQueries({ queryKey: [...TASK_RUNS_KEY] });
  };
  useEventSubscription('task_run_failed', refreshRuns);
  useEventSubscription('task_run_updated', refreshRuns);
}
