import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { CreateTaskInput, UpdateTaskRequest } from '@dorkos/shared/types';

/** Query key for the Tasks list — shared with {@link useTasksSync} for invalidation. */
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
      queryClient.invalidateQueries({ queryKey: [...TASKS_KEY] });
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
      queryClient.invalidateQueries({ queryKey: [...TASKS_KEY] });
    },
  });
}

/** Delete a Task. */
export function useDeleteTask() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.deleteTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...TASKS_KEY] });
    },
  });
}

/** Trigger a manual run of a Task. */
export function useTriggerTask() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.triggerTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks', 'runs'] });
    },
  });
}
