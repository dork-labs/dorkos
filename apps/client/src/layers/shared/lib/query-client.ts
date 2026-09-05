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
import { addBreadcrumb } from './breadcrumbs';

/**
 * Open the feedback dialog as a bug report from an error toast's "Report" action.
 *
 * The toast handlers run OUTSIDE React (they are cache callbacks, not
 * components), so they reach the dialog through its shared store. The store is
 * imported lazily — a static import from this widely-imported module into
 * `shared/model` risks an import cycle (`shared/model` re-exports code that
 * imports this file), the same reason `event-stream-context.tsx` reaches back
 * here with a dynamic import. `getState()` is the store's out-of-React seam.
 *
 * @param message - A prefilled message stub (the action name plus the error).
 */
function reportBugFromToast(message: string): void {
  void import('@/layers/shared/model/feedback-dialog/feedback-dialog-store').then((m) =>
    m.useFeedbackDialogStore.getState().openFeedback({ kind: 'bug', message })
  );
}

/** The "Report" toast action that opens a prefilled bug report. */
function reportAction(message: string): { label: string; onClick: () => void } {
  return { label: 'Report', onClick: () => reportBugFromToast(message) };
}

/**
 * Is this cache entry kept current by a durable subscription of its own?
 *
 * A query that declares `meta.streamOwned` is hydrated once by its read and
 * written from then on by a stream that resumes from a cursor and is gap-free.
 * Re-reading it is not a re-sync but a step backwards: the GET answers with
 * whatever page the server returns — a room's history read returns only the
 * TRAILING page — and it lands over anything the socket delivered while it was
 * in flight, which nothing re-delivers.
 *
 * So a broom that sweeps the whole cache has to be told what to leave alone.
 * `installReconnectInvalidation` is the one that does, and the flag is checked
 * rather than the key so `shared` never has to name a key an upper layer owns.
 *
 * @param query - Any query the cache holds.
 * @returns True when only its own stream may write it.
 */
export function isStreamOwnedQuery(query: { meta?: Record<string, unknown> }): boolean {
  return query.meta?.streamOwned === true;
}

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
        addBreadcrumb('query_error', `${String(query.queryKey[0] ?? 'query')}: ${error.message}`);
        if (query.meta?.showToastOnError) {
          const label = (query.meta.errorLabel as string) ?? "Couldn't load that. Try again.";
          toast.error(label, { action: reportAction(`${label}: ${error.message}`) });
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _onMutateResult, mutation) => {
        console.error('[dorkos:mutation-error]', { error: error.message });
        // Recorded under `query_error`, which the breadcrumb enum uses for any
        // failed data operation (query or mutation) — the bug-report trail only
        // needs "a data call failed here", not the query/mutation distinction,
        // so the enum stays small. The message is prefixed with the mutation key.
        addBreadcrumb(
          'query_error',
          `${String(mutation.options?.mutationKey?.[0] ?? 'mutation')}: ${error.message}`
        );
        if (mutation.meta?.suppressErrorToast) return;
        // `errorLabel` names the action in the user's terms; the server's own
        // sentence says why. The authored line is the HEADLINE and the raw text
        // is the description under it (DOR-1755): they used to be joined with an
        // em dash into one line, which put "ENOENT: no such file or directory"
        // in the same breath as the sentence written for a person, and the house
        // rule bans the dash anyway.
        const label = mutation.meta?.errorLabel as string | undefined;
        // `errorToastId` collapses repeats. A mutation a person can only fire
        // once wants one toast per failure; a mutation they can fire ten times
        // in three seconds — tapping a reaction in a room that has stopped
        // answering — wants the tenth failure to REPLACE the first line rather
        // than stack a column of identical ones. Sonner keys on the id.
        const id = mutation.meta?.errorToastId as string | undefined;
        const headline = label ?? "That didn't work. Try again.";
        // Every failure toast now carries a "Report" action that opens a
        // prefilled bug report — the highest-intent moment to capture one. The
        // report still gets both halves on one line, because that is a bug
        // report and not something a person has to read at a glance.
        //
        // The `id` (when set) still collapses repeats; it is merged into the
        // same options object as the action.
        toast.error(headline, {
          description: error.message,
          action: reportAction(`${headline}: ${error.message}`),
          ...(id !== undefined ? { id } : {}),
        });
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
