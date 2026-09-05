import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { SubagentInfo } from '@dorkos/shared/types';

/**
 * Fetch available subagents from the server. Long staleTime since agents rarely change.
 *
 * @param sessionId - Optional active session id. When provided, the server
 *   resolves the runtime that owns the session. When absent, the server falls
 *   back to the default runtime (cold-discovery path — onboarding, first-run).
 */
export function useSubagents(sessionId?: string) {
  const transport = useTransport();

  return useQuery<SubagentInfo[]>({
    queryKey: ['subagents', sessionId ?? null],
    queryFn: () => transport.getSubagents({ sessionId }),
    staleTime: 30 * 60 * 1000,
  });
}
