import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { UninstallOptions, UninstallResult } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/** Arguments passed to the uninstall mutation. */
export interface UninstallPackageArgs {
  /** Package name (e.g. `@org/my-plugin`). */
  name: string;
  /** Options: purge user data and/or specify a project path. */
  options?: UninstallOptions;
}

/**
 * Uninstall a marketplace package, optionally purging persisted user data.
 *
 * Invalidates the installed-packages list and the individual package-detail
 * cache on success. The all-packages browse cache is not invalidated because
 * uninstalling does not remove a package from the source registry.
 */
export function useUninstallPackage() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<UninstallResult, Error, UninstallPackageArgs>({
    mutationFn: ({ name, options }) => transport.uninstallMarketplacePackage(name, options),
    onSuccess: (_result, { name }) => {
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packageDetail(name) });
    },
  });
}
