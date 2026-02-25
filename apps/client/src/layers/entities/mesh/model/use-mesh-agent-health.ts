import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/**
 * Fetch health details for a specific mesh agent by ID.
 *
 * The query is disabled when `agentId` is null, allowing conditional fetching
 * based on selection state.
 *
 * @param agentId - The agent ID to fetch health for, or null to skip.
 */
export function useMeshAgentHealth(agentId: string | null) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['mesh', 'agent-health', agentId],
    queryFn: () => transport.getMeshAgentHealth(agentId!),
    enabled: agentId !== null,
  });
}
