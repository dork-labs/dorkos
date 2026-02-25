import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/**
 * Send a heartbeat event for a mesh agent.
 *
 * On success, invalidates both the aggregate mesh status and the specific
 * agent health queries so UI reflects updated liveness immediately.
 */
export function useMeshHeartbeat() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, event }: { id: string; event?: string }) =>
      transport.sendMeshHeartbeat(id, event),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'status'] });
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agent-health', variables.id] });
    },
  });
}
