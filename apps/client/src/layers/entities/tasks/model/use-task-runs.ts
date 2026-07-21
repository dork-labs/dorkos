import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ListTaskRunsQuery } from '@dorkos/shared/types';

/** Query-key prefix for every Task-runs cache. Exported so cross-cutting freshness bridges can invalidate it. */
export const TASK_RUNS_KEY = ['tasks', 'runs'] as const;

/**
 * Fetch Task runs with optional filters.
 *
 * @param opts - Optional query filters (taskId, status, limit).
 * @param enabled - When false, the query is skipped entirely (Tasks feature gate).
 */
export function useTaskRuns(opts?: Partial<ListTaskRunsQuery>, enabled = true) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...TASK_RUNS_KEY, opts],
    queryFn: () => transport.listTaskRuns(opts),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'running') ? 10_000 : false,
    refetchIntervalInBackground: false,
    enabled,
  });
}

/** Fetch a single Task run by ID. */
export function useTaskRun(id: string | null) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...TASK_RUNS_KEY, id],
    queryFn: () => transport.getTaskRun(id!),
    enabled: !!id,
  });
}

/**
 * Return the count of currently running Tasks.
 *
 * @param enabled - When false the query is skipped (Tasks feature gate).
 */
export function useActiveTaskRunCount(enabled = true) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...TASK_RUNS_KEY, 'active-count'],
    queryFn: async () => {
      const runs = await transport.listTaskRuns({ limit: 50 });
      return runs.filter((r) => r.status === 'running').length;
    },
    enabled,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

/** Cancel a running Task. */
export function useCancelTaskRun() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.cancelTaskRun(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...TASK_RUNS_KEY] });
    },
  });
}
