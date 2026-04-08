import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';
import type { MarketplacePackageDetail } from '@dorkos/shared/marketplace-schemas';

/**
 * Fetch the full manifest and permission preview for a single marketplace package.
 *
 * Pass `enabled: false` to defer the fetch until the user opens a detail sheet.
 * Pass a `marketplace` source name to restrict the lookup when multiple sources
 * may carry the same package name.
 *
 * @param name - Fully-qualified package name (e.g. `@org/my-plugin`), or null to skip.
 * @param options - Optional `enabled` flag and `marketplace` source restriction.
 */
export function useMarketplacePackage(
  name: string | null,
  options?: { enabled?: boolean; marketplace?: string }
) {
  const transport = useTransport();
  const { enabled = true, marketplace } = options ?? {};

  return useQuery<MarketplacePackageDetail>({
    queryKey: marketplaceKeys.packageDetail(name ?? ''),
    queryFn: () => transport.getMarketplacePackage(name!, marketplace),
    enabled: enabled && name !== null,
    staleTime: 60_000,
  });
}
