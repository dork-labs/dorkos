/**
 * Singleton TanStack Query client — shared across the app and importable
 * by non-React code (e.g. the SSE reconnection handler) via dynamic import.
 *
 * Error handling strategy:
 * - QueryCache.onError: Logs all query errors for telemetry. Shows toast only
 *   when the query opts in via `meta.showToastOnError`.
 * - MutationCache.onError: Shows a toast for all failed mutations, unless the
 *   mutation opts out via `meta.suppressErrorToast`. A mutation's own `onError`
 *   does NOT replace this one — TanStack awaits the cache handler and then the
 *   mutation's, so both fire. Opt out via `meta` when the surface already
 *   renders the failure itself (e.g. an inline form error), or the user sees
 *   the same problem reported twice in two different voices.
 *
 *   Prefer `meta.errorLabel` over opting out. This handler is the only failure
 *   report that always reaches the user: it runs on the mutation itself
 *   (`mutation.js:148`), whereas a `mutate(…, { onError })` callback is
 *   dispatched only while the observer still has listeners
 *   (`mutationObserver.js:77`) — so it is skipped when the component unmounted
 *   or a second `mutate()` superseded the first. A surface that opts out and
 *   handles the error at the call site is a surface that can fail in silence.
 *
 * throwOnError is NOT set globally — it's opt-in per query:
 * - Background/polling queries: never throw (stale data > crashed page)
 * - Critical page content: use throwOnError + QueryErrorResetBoundary
 * - Optional widget data: handle isError inline in the component
 *
 * @module shared/lib/query-client
 */
import {
  QueryClient,
  QueryCache,
  MutationCache,
  type QueryClientConfig,
} from '@tanstack/react-query';
import { toast } from 'sonner';

import { QUERY_TIMING } from './constants';

/**
 * Build the app's QueryClient configuration.
 *
 * A factory rather than a shared object because a QueryCache and a MutationCache
 * are stateful — handing the same instances to two clients would let one leak
 * into the other.
 *
 * Exported so a test can stand up a throwaway client carrying the *real* error
 * policy instead of re-declaring it. Re-declaring it is how a test that asserts
 * "this surface never shows the generic toast" quietly stops asserting anything.
 *
 * @returns A fresh configuration, caches included.
 */
export function createQueryClientConfig(): QueryClientConfig {
  return {
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
        // `errorLabel` names the action in the user's terms; the server's own
        // sentence says why. Together they read like a person explaining what
        // went wrong — "Couldn't send your message — This room is archived" —
        // which is what the generic line below can never do.
        const label = mutation.meta?.errorLabel as string | undefined;
        toast.error(label ? `${label} — ${error.message}` : 'Action failed. Please try again.');
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: QUERY_TIMING.DEFAULT_STALE_TIME_MS,
        retry: QUERY_TIMING.DEFAULT_RETRY,
      },
    },
  };
}

/** Application-wide QueryClient singleton. */
export const queryClient = new QueryClient(createQueryClientConfig());
