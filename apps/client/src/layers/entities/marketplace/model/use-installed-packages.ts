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
 * @param options - Query options.
 * @param options.enabled - False to ask for nothing at all. For a caller that
 *   only sometimes has an agent to ask about — the profile's rows read this on
 *   every identity, and a person has no installed packages to list.
 */
export function useInstalledPackages(projectPath?: string, options?: { enabled?: boolean }) {
  const transport = useTransport();
  return useQuery<InstalledPackage[]>({
    queryKey: marketplaceKeys.installed(projectPath),
    queryFn: () => transport.listInstalledPackages(projectPath),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}
