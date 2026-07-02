import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';

/**
 * List every installation of a single marketplace package across all scopes —
 * global plus each registered agent — enriched with capability summaries
 * (`provides`: command/skill counts + hooks presence). Backs the installations
 * panel in the package detail drawer.
 *
 * @param name - Installed package name, or `null` to disable the query.
 * @param options - `enabled` gate (default true); pass `false` while the
 *   package is not yet known to be installed to avoid a 404.
 */
export function usePackageInstallations(name: string | null, options?: { enabled?: boolean }) {
  const transport = useTransport();
  return useQuery<InstalledPackage[]>({
    queryKey: marketplaceKeys.installedDetail(name ?? ''),
    queryFn: () => transport.listPackageInstallations(name as string),
    enabled: (options?.enabled ?? true) && name !== null,
    staleTime: 60_000,
  });
}
