import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { Transport } from '@dorkos/shared/transport';
import type { ModelOption } from '@dorkos/shared/types';

/**
 * Build the TanStack Query options for a runtime's model catalog — the ONE
 * query definition {@link useModels} and any batch consumer (`useQueries`,
 * e.g. the fleet rollup fetching several runtimes' catalogs at once) share, so
 * the query key and fetcher can never drift into two subtly different caches.
 *
 * @param transport - The active transport (from `useTransport`).
 * @param opts.sessionId - Optional active session id (server resolves its runtime).
 * @param opts.runtime - Optional runtime type; also keys the cache per runtime.
 */
export function modelsQueryOptions(
  transport: Transport,
  opts?: { sessionId?: string; runtime?: string }
) {
  const sessionId = opts?.sessionId;
  const runtime = opts?.runtime;
  return {
    queryKey: ['models', runtime ?? null, sessionId ?? null] as const,
    queryFn: () => transport.getModels({ sessionId, runtime }),
    staleTime: 30 * 60 * 1000,
  };
}

/**
 * Fetch available models from the server. Long staleTime since models rarely change.
 *
 * @param opts.sessionId - Optional active session id. When provided, the server
 *   resolves the runtime that owns the session.
 * @param opts.runtime - Optional runtime type (e.g. `'codex'`). Threads the
 *   client-known runtime so a not-yet-started session — which has no
 *   server-side metadata row to resolve `sessionId` against — still gets the
 *   correct runtime's catalog instead of the default runtime's. Also keys the
 *   cache, so switching the pre-launch runtime selection refetches rather than
 *   serving a stale list. When both are absent, the server falls back to the
 *   default runtime (cold-discovery path — onboarding, first-run).
 */
export function useModels(opts?: { sessionId?: string; runtime?: string }) {
  const transport = useTransport();
  return useQuery<ModelOption[]>(modelsQueryOptions(transport, opts));
}
