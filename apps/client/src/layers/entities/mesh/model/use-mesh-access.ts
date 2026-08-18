import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { OPEN_MESH_NAMESPACE, type TopologyView } from '@dorkos/shared/mesh-schemas';
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
    mutationFn: (body: {
      sourceNamespace: string;
      targetNamespace: string;
      action: 'allow' | 'deny';
    }) => transport.updateMeshAccessRule(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TOPOLOGY_KEY });
    },
  });
}

/**
 * Mutation for the mesh-wide "Let all my agents talk to each other" switch —
 * the `* -> *` access rule (`true` adds it, `false` removes it).
 *
 * Flips `openMesh` in every cached topology view immediately so the switch
 * responds on the click rather than on the round trip, rolls every one of them
 * back if the request fails, and refetches either way so the server has the
 * last word.
 */
export function useSetOpenMesh() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (open: boolean) =>
      transport.updateMeshAccessRule({
        sourceNamespace: OPEN_MESH_NAMESPACE,
        targetNamespace: OPEN_MESH_NAMESPACE,
        action: open ? 'allow' : 'deny',
      }),
    onMutate: async (open: boolean) => {
      await queryClient.cancelQueries({ queryKey: TOPOLOGY_KEY });
      const previous = queryClient.getQueriesData<TopologyView>({ queryKey: TOPOLOGY_KEY });
      queryClient.setQueriesData<TopologyView>({ queryKey: TOPOLOGY_KEY }, (old) =>
        old ? { ...old, openMesh: open } : old
      );
      return { previous };
    },
    onError: (_error, _open, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
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
