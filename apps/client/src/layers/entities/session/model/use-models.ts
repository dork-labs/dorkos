import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ModelOption } from '@dorkos/shared/types';

/**
 * Fetch available models from the server. Long staleTime since models rarely change.
 *
 * @param sessionId - Optional active session id. When provided, the server
 *   resolves the runtime that owns the session. When absent, the server falls
 *   back to the default runtime (cold-discovery path — onboarding, first-run).
 */
export function useModels(sessionId?: string) {
  const transport = useTransport();

  return useQuery<ModelOption[]>({
    queryKey: ['models', sessionId ?? null],
    queryFn: () => transport.getModels({ sessionId }),
    staleTime: 30 * 60 * 1000,
  });
}
