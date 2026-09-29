import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { AddSourceInput, AddedMarketplaceSource } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/**
 * Add a new marketplace source (git registry URL).
 *
 * Invalidates both the sources list and the all-packages browse cache on
 * success: the server fetches the new source's listing as part of the add, so
 * its packages can join the browse view immediately.
 *
 * @returns The created source, with how the first fetch of its listing went.
 */
export function useAddMarketplaceSource() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<AddedMarketplaceSource, Error, AddSourceInput>({
    mutationFn: (input) => transport.addMarketplaceSource(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.sources() });
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packages() });
    },
  });
}
