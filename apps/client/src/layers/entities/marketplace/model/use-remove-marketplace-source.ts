import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';

/**
 * Remove a configured marketplace source by name.
 *
 * Invalidates both the sources list and the all-packages browse cache on
 * success, because packages from the removed source will no longer appear
 * in the browse view after the cache refetches.
 *
 * @remarks
 * The mutation variable is the source name string (not an options object)
 * because the transport only accepts a single name argument for this operation.
 */
export function useRemoveMarketplaceSource() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (name) => transport.removeMarketplaceSource(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.sources() });
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packages() });
    },
  });
}
