import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Delete an agent and its `.dork` directory by ID. */
export function useDeleteAgentData() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.deleteAgentData(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      queryClient.invalidateQueries({ queryKey: ['mesh', 'topology'] });
    },
  });
}
