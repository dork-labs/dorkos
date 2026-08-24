import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ListTaskRunsQuery, TaskRun } from '@dorkos/shared/types';

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

/** Options for {@link useInfiniteTaskRuns} — the same filters as {@link useTaskRuns}, minus the offset it owns. */
export type InfiniteTaskRunsOptions = Omit<Partial<ListTaskRunsQuery>, 'offset'> & {
  /** Page size. Also the "is there another page?" test: a short page is the last one. */
  limit: number;
};

/**
 * Fetch Task runs a page at a time, keeping every loaded page live.
 *
 * **Why an infinite query and not accumulated state.** The run-history panel used
 * to freeze each loaded page into a `useState` array and concatenate. A run's
 * status is not a fixed fact — it goes `running` → `completed`/`failed` while you
 * are looking at it — and a frozen page can never hear about that, so scrolling
 * past twenty runs left a permanently spinning row for a run that had finished
 * minutes ago. TanStack refetches every page of an infinite query together, so a
 * run that goes terminal updates in place wherever it is on the list.
 *
 * The key sits under {@link TASK_RUNS_KEY}, so the invalidations in
 * `useCancelTaskRun` and `useTriggerTask` reach it like any other run query.
 *
 * **No `maxPages`, deliberately.** Refetching every page is what keeps old rows
 * honest, and it costs one request per loaded page per poll tick — five pages of
 * history with something still running is five requests every ten seconds.
 * Capping with `maxPages` would bound that, but TanStack bounds it by DROPPING
 * the page at the far end, so pressing "Load more" a sixth time would silently
 * delete the twenty rows at the top of a list the person is reading. Losing rows
 * to save requests is the wrong trade for a panel that only exists while a
 * schedule row is expanded and only polls while a run is actually going. Revisit
 * if run history ever grows an always-mounted surface.
 *
 * @param opts - Filters plus the page size.
 * @param enabled - When false, the query is skipped entirely (Tasks feature gate).
 */
export function useInfiniteTaskRuns(opts: InfiniteTaskRunsOptions, enabled = true) {
  const transport = useTransport();
  const { limit } = opts;

  return useInfiniteQuery({
    queryKey: [...TASK_RUNS_KEY, 'infinite', opts],
    queryFn: ({ pageParam }) => transport.listTaskRuns({ ...opts, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: TaskRun[], _pages, lastPageParam: number) =>
      lastPage.length < limit ? undefined : lastPageParam + limit,
    // Same poll as `useTaskRuns`, asked across every loaded page: one run still
    // going anywhere in the history keeps the whole list refreshing.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.some((run) => run.status === 'running'))
        ? 10_000
        : false,
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

/**
 * Cancel a running Task.
 *
 * `TaskRunHistoryPanel` reports the outcome itself on success (a neutral
 * status line — "already finished" vs "stopping" — not a confirmation that
 * the click worked), but a failure has nowhere as specific to land, so this
 * mutation names it for the shared toast (`query-client.ts`'s
 * `MutationCache.onError`) rather than doubling up with its own.
 */
export function useCancelTaskRun() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.cancelTaskRun(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...TASK_RUNS_KEY] });
    },
    meta: { errorLabel: "Couldn't stop the run" },
  });
}
