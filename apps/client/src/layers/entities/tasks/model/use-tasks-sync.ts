import { useQueryClient } from '@tanstack/react-query';
import { useEventSubscription } from '@/layers/shared/model';
import { TASKS_KEY } from './use-tasks';

/**
 * Keep the Tasks list fresh across clients and tabs.
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
 *
 * Mount once near the app root, beside the other `*Sync` hooks. In embedded
 * mode (Obsidian) the in-process transport yields no generic events, so the
 * subscription is an inert no-op there.
 */
export function useTasksSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('tasks_changed', () => {
    void queryClient.invalidateQueries({ queryKey: [...TASKS_KEY], exact: true });
  });
}
