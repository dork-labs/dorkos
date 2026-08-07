import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Unregister a mesh agent by ID. */
export function useUnregisterAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.unregisterMeshAgent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      // An agent that is gone has to leave the Team roster too. A raw literal:
      // one entity may not import a sibling entity's constant.
      queryClient.invalidateQueries({ queryKey: ['team'] });
    },
  });
}
