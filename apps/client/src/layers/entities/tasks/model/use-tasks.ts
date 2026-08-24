import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { CreateTaskInput, UpdateTaskRequest } from '@dorkos/shared/types';
import { TASK_RUNS_KEY } from './use-task-runs';

/**
 * Query key for the Tasks list — shared with {@link useTasksSync} for invalidation.
 *
 * **Always invalidate this key with `exact: true`.** `['tasks']` is a PREFIX of
 * the chat panel's per-session todo query, `['tasks', sessionId, cwd]`
 * (`features/chat/model/use-task-state.ts`), and TanStack Query matches query
 * keys by prefix unless told otherwise. A prefix invalidation therefore refetches
 * — and resets — a session's streamed todo list mid-turn every time any schedule
 * anywhere changes. {@link useTasksSync} gets this right; the mutations below
 * used not to.
 */
export const TASKS_KEY = ['tasks'] as const;

/**
 * Fetch all Tasks.
 *
 * @param enabled - When false, the query is skipped entirely (Tasks feature gate).
 */
export function useTasks(enabled = true) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...TASKS_KEY],
    queryFn: () => transport.listTasks(),
    enabled,
  });
}

/** Create a new Task. */
export function useCreateTask() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTaskInput) => transport.createTask(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...TASKS_KEY], exact: true });
    },
  });
}

/** Update an existing Task. */
export function useUpdateTask() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdateTaskRequest) =>
      transport.updateTask(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...TASKS_KEY], exact: true });
    },
    // The shared mutation toast (`query-client.ts`) reports the failure —
    // `TaskRow.tsx`'s own call-time `onError` used to duplicate it.
    meta: { errorLabel: "Couldn't update the schedule" },
  });
}

/** Delete a Task. */
export function useDeleteTask() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.deleteTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...TASKS_KEY], exact: true });
      // Deleting a schedule erases its runs too — the server cascades them
      // (`task-store.ts`). The old prefix-matching invalidation refreshed the run
      // queries by accident; now that the list invalidation is `exact`, this has
      // to say so out loud. Without it the top-nav health dot keeps a red count
      // for runs that no longer exist (its failed-runs query does not poll, and
      // the nav stays mounted while Tasks is only a dialog).
      queryClient.invalidateQueries({ queryKey: [...TASK_RUNS_KEY] });
    },
    meta: { errorLabel: "Couldn't delete the schedule" },
  });
}

/** Trigger a manual run of a Task. */
export function useTriggerTask() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.triggerTask(id),
    onSuccess: () => {
      // No `exact` here, on purpose: every run query — filtered, paginated,
      // single-run — hangs off `['tasks', 'runs', …]`, and a fresh run belongs
      // in all of them. The chat panel's `['tasks', sessionId, cwd]` todo query
      // is not underneath it, so the prefix match cannot reach that.
      queryClient.invalidateQueries({ queryKey: [...TASK_RUNS_KEY] });
    },
    meta: { errorLabel: "Couldn't run the scheduled task" },
  });
}
