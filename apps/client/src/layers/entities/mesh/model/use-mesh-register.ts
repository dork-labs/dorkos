import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** Register a discovered agent into the mesh registry. */
export function useRegisterAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (opts: {
      path: string;
      overrides?: Partial<AgentManifest>;
      approver?: string;
      /** Scan root the agent was found under — drives ADR-0032 namespace derivation. */
      scanRoot?: string;
    }) => transport.registerMeshAgent(opts.path, opts.overrides, opts.approver, opts.scanRoot),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agent-paths'] });
    },
  });
}
