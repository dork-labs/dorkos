import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';
import type { MarketplacePackageDetail, InstallOptions } from '@dorkos/shared/marketplace-schemas';

/**
 * Build a permission preview for a marketplace package without installing it.
 *
 * Shows file changes, extensions registered, tasks created, secrets required,
 * external hosts contacted, dependency satisfaction, and conflict reports.
 * Shorter staleTime (30 s) because the preview reflects current installed state,
 * which can change if another install completes in the same session.
 *
 * Pass `enabled: false` to defer the fetch until the user explicitly requests
 * the preview (e.g. opening the permission sheet).
 *
 * @param name - Package name to preview, or null to skip.
 * @param options - Optional `enabled` flag and `InstallOptions` (marketplace, source, projectPath).
 */
export function usePermissionPreview(
  name: string | null,
  options?: { enabled?: boolean } & InstallOptions
) {
  const transport = useTransport();
  const { enabled = true, ...installOpts } = options ?? {};

  // Only forward non-empty InstallOptions to avoid cache key noise.
  const hasOpts = Object.keys(installOpts).length > 0;

  return useQuery<MarketplacePackageDetail>({
    queryKey: marketplaceKeys.permissionPreview(name ?? ''),
    queryFn: () => transport.previewMarketplacePackage(name!, hasOpts ? installOpts : undefined),
    enabled: enabled && name !== null,
    staleTime: 30_000,
  });
}
