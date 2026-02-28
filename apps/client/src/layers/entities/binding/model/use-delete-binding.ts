import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { BINDINGS_QUERY_KEY } from './use-bindings';

/**
 * Delete an adapter-agent binding by ID.
 * Invalidates the bindings cache on success.
 */
export function useDeleteBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.deleteBinding(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
  });
}
