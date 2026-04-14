import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Clear a denial record, allowing the agent path to be re-discovered. */
export function useClearDenial() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (path: string) => transport.clearMeshDenial(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'denied'] });
    },
  });
}
