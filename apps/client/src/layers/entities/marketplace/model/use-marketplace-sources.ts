import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';
import type { MarketplaceSource } from '@dorkos/shared/marketplace-schemas';

/**
 * List all configured marketplace sources (git registries).
 *
 * Mutation hooks (addMarketplaceSource, removeMarketplaceSource) should call
 * `queryClient.invalidateQueries({ queryKey: marketplaceKeys.sources() })`
 * on success to keep this list fresh.
 */
export function useMarketplaceSources() {
  const transport = useTransport();
  return useQuery<MarketplaceSource[]>({
    queryKey: marketplaceKeys.sources(),
    queryFn: () => transport.listMarketplaceSources(),
    staleTime: 60_000,
  });
}
