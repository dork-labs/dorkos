import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';

/**
 * Fetch a single installed marketplace package, enriched with its capability
 * summary (`provides`: command/skill counts + hooks presence). Backs the
 * installed-state panel in the package detail drawer.
 *
 * @param name - Installed package name, or `null` to disable the query.
 * @param options - `enabled` gate (default true); pass `false` while the
 *   package is not yet known to be installed to avoid a 404.
 * @param projectPath - Optional agent project path for scoped lookup.
 */
export function useInstalledPackage(
  name: string | null,
  options?: { enabled?: boolean },
  projectPath?: string
) {
  const transport = useTransport();
  return useQuery<InstalledPackage>({
    queryKey: marketplaceKeys.installedDetail(name ?? '', projectPath),
    queryFn: () => transport.getInstalledPackage(name as string, projectPath),
    enabled: (options?.enabled ?? true) && name !== null,
    staleTime: 60_000,
  });
}
