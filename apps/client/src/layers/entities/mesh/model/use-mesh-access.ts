import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

const TOPOLOGY_KEY = ['mesh', 'topology'] as const;

/**
 * Mutation to create or remove a cross-namespace access rule.
 * Invalidates topology queries on success.
 */
export function useUpdateAccessRule() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: { sourceNamespace: string; targetNamespace: string; action: 'allow' | 'deny' }) =>
      transport.updateMeshAccessRule(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TOPOLOGY_KEY });
    },
  });
}

/**
 * Fetch agents reachable by a specific agent.
 *
 * @param agentId - The agent ID to check access for
 * @param enabled - When false, the query is skipped
 */
export function useAgentAccess(agentId: string, enabled = true) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['mesh', 'agent-access', agentId],
    queryFn: () => transport.getMeshAgentAccess(agentId),
    enabled: enabled && !!agentId,
    staleTime: 30_000,
  });
}
