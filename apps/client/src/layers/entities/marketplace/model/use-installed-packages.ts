import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';

/**
 * List all marketplace packages currently installed in the DorkOS data directory.
 *
 * Mutation hooks (install, uninstall, update) should call
 * `queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() })`
 * on success to keep this list fresh.
 */
export function useInstalledPackages() {
  const transport = useTransport();
  return useQuery<InstalledPackage[]>({
    queryKey: marketplaceKeys.installed(),
    queryFn: () => transport.listInstalledPackages(),
    staleTime: 60_000,
  });
}
