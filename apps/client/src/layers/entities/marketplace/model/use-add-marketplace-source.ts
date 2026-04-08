import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { AddSourceInput, MarketplaceSource } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/**
 * Add a new marketplace source (git registry URL).
 *
 * Invalidates both the sources list and the all-packages browse cache on
 * success, because the newly added source may contribute additional packages
 * to the browse view immediately.
 *
 * @returns The created {@link MarketplaceSource} as returned by the server.
 */
export function useAddMarketplaceSource() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<MarketplaceSource, Error, AddSourceInput>({
    mutationFn: (input) => transport.addMarketplaceSource(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.sources() });
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packages() });
    },
  });
}
