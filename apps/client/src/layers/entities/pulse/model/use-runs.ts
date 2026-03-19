import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ListRunsQuery } from '@dorkos/shared/types';

const RUNS_KEY = ['pulse', 'runs'] as const;

/**
 * Fetch Pulse runs with optional filters.
 *
 * @param opts - Optional query filters (scheduleId, status, limit).
 * @param enabled - When false, the query is skipped entirely (Pulse feature gate).
 */
export function useRuns(opts?: Partial<ListRunsQuery>, enabled = true) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...RUNS_KEY, opts],
    queryFn: () => transport.listRuns(opts),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'running') ? 10_000 : false,
    refetchIntervalInBackground: false,
    enabled,
  });
}

/** Fetch a single Pulse run by ID. */
export function useRun(id: string | null) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...RUNS_KEY, id],
    queryFn: () => transport.getRun(id!),
    enabled: !!id,
  });
}

/**
 * Return the count of currently running Pulse jobs.
 *
 * @param enabled - When false the query is skipped (Pulse feature gate).
 */
export function useActiveRunCount(enabled = true) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...RUNS_KEY, 'active-count'],
    queryFn: async () => {
      const runs = await transport.listRuns({ limit: 50 });
      return runs.filter((r) => r.status === 'running').length;
    },
    enabled,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

/** Cancel a running Pulse job. */
export function useCancelRun() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.cancelRun(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...RUNS_KEY] });
    },
  });
}
