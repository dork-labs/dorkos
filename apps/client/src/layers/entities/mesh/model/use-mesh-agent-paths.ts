import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

const AGENT_PATHS_KEY = ['mesh', 'agent-paths'] as const;

/**
 * Fetch registered agents with their project paths (lightweight, for
 * onboarding/scheduling).
 *
 * @param options.enabled - Ask the server at all. `false` holds it idle for a
 *   caller that is mounted but not drawing anything; another enabled observer
 *   still fetches it.
 */
export function useMeshAgentPaths(options: { enabled?: boolean } = {}) {
  const transport = useTransport();

  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [...AGENT_PATHS_KEY],
    queryFn: () => transport.listMeshAgentPaths(),
    staleTime: 30_000,
  });
}
