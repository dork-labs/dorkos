import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { AgentManifestUpdate } from '@dorkos/shared/mesh-schemas';

/**
 * Update an existing mesh agent's metadata — the OPERATOR's write path.
 *
 * `PATCH /api/mesh/agents/:id`, not the agent self-edit route: every setting a
 * person owns and an agent may not give itself goes through here — its billing
 * account, its tool groups, its rooms-management grant and its tier ceiling
 * (`services/core/operator/agent-write-policy.ts`).
 *
 * It clears `['mesh','agents']` and nothing else. A surface that renders the
 * manifest from another cache — `useCurrentAgent`, `useResolvedAgents` — hangs
 * its own invalidation on the `mutate` call, because this hook has no way to
 * know which one it is.
 */
export function useUpdateAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (opts: { id: string; updates: AgentManifestUpdate }) =>
      transport.updateMeshAgent(opts.id, opts.updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
    },
  });
}
