import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { BINDINGS_QUERY_KEY } from './use-bindings';

/**
 * Update an existing adapter-agent binding's mutable fields.
 * Invalidates the bindings cache on success.
 */
export function useUpdateBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string;
      updates: Partial<
        Pick<
          AdapterBinding,
          | 'sessionStrategy'
          | 'label'
          | 'chatId'
          | 'channelType'
          | 'canInitiate'
          | 'canReply'
          | 'canReceive'
        >
      >;
    }) => transport.updateBinding(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
  });
}
