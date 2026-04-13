import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';

/**
 * List marketplace packages installed in the DorkOS data directory.
 *
 * @param projectPath - Optional agent project path for scoped listing.
 *   When provided, returns merged global + agent-local packages with scope tags.
 *   When omitted, returns global packages only.
 */
export function useInstalledPackages(projectPath?: string) {
  const transport = useTransport();
  return useQuery<InstalledPackage[]>({
    queryKey: marketplaceKeys.installed(projectPath),
    queryFn: () => transport.listInstalledPackages(projectPath),
    staleTime: 60_000,
  });
}
