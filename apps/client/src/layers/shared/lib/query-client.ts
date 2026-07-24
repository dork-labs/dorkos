/**
 * Singleton TanStack Query client — shared across the app and importable
 * by non-React code (e.g. the SSE reconnection handler) via dynamic import.
 *
 * Error handling strategy:
 * - QueryCache.onError: Logs all query errors for telemetry. Shows toast only
 *   when the query opts in via `meta.showToastOnError`.
 * - MutationCache.onError: Shows a generic toast for all failed mutations,
 *   unless the mutation opts out via `meta.suppressErrorToast`. A mutation's own
 *   `onError` does NOT replace this one — TanStack awaits the cache handler and
 *   then the mutation's, so both fire. Opt out via `meta` when the surface
 *   already renders the failure itself (e.g. an inline form error), or the user
 *   sees the same problem reported twice in two different voices.
 *
 * throwOnError is NOT set globally — it's opt-in per query:
 * - Background/polling queries: never throw (stale data > crashed page)
 * - Critical page content: use throwOnError + QueryErrorResetBoundary
 * - Optional widget data: handle isError inline in the component
 *
 * @module shared/lib/query-client
 */
import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { toast } from 'sonner';

import { QUERY_TIMING } from './constants';

/** Application-wide QueryClient singleton. */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error('[dorkos:query-error]', {
        queryKey: query.queryKey,
        error: error.message,
      });
      if (query.meta?.showToastOnError) {
        toast.error((query.meta.errorLabel as string) ?? 'Failed to load data');
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _onMutateResult, mutation) => {
      console.error('[dorkos:mutation-error]', { error: error.message });
      if (mutation.meta?.suppressErrorToast) return;
      toast.error('Action failed. Please try again.');
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: QUERY_TIMING.DEFAULT_STALE_TIME_MS,
      retry: QUERY_TIMING.DEFAULT_RETRY,
    },
  },
});
