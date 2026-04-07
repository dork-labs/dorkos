import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';
import type { AggregatedPackage, PackageFilter } from '@dorkos/shared/marketplace-schemas';

/**
 * Fetch marketplace packages from all enabled sources, optionally filtered.
 *
 * Browse data is treated as fairly static — staleTime of 60 s means the user
 * can navigate between pages without re-fetching on every mount.
 *
 * @param filter - Optional filter by type, marketplace source name, or free-text query.
 */
export function useMarketplacePackages(filter?: PackageFilter) {
  const transport = useTransport();
  return useQuery<AggregatedPackage[]>({
    queryKey: marketplaceKeys.packageList(filter),
    queryFn: () => transport.listMarketplacePackages(filter),
    staleTime: 60_000,
  });
}
