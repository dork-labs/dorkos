import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';

/**
 * List marketplace packages installed in the DorkOS data directory.
 *
 * Every caller is a marketplace surface a person opened on purpose, so there is
 * no `enabled` flag: the one caller that had to ask conditionally was the
 * profile's Skills row, and it now reads the harness status instead.
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
