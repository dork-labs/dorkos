import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { CreateBindingRequest } from '@dorkos/shared/relay-schemas';
import { BINDINGS_QUERY_KEY } from './use-bindings';

/**
 * Create a new adapter-agent binding.
 * Invalidates the bindings cache on success.
 */
export function useCreateBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBindingRequest) => transport.createBinding(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
  });
}
