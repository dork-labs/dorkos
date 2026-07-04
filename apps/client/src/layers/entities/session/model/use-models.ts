import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ModelOption } from '@dorkos/shared/types';

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
  const sessionId = opts?.sessionId;
  const runtime = opts?.runtime;

  return useQuery<ModelOption[]>({
    queryKey: ['models', runtime ?? null, sessionId ?? null],
    queryFn: () => transport.getModels({ sessionId, runtime }),
    staleTime: 30 * 60 * 1000,
  });
}
