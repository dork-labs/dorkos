import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { UpdateOptions, UpdateResult } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/** Arguments passed to the update mutation. */
export interface UpdatePackageArgs {
  /** Package name (e.g. `@org/my-plugin`). */
  name: string;
  /**
   * Update options.
   *
   * Pass `{ apply: true }` to reinstall in place; omit for an advisory check
   * that returns update availability without mutating disk state.
   */
  options?: UpdateOptions;
}

/**
 * Check for (and optionally apply) updates to an installed marketplace package.
 *
 * Advisory by default — the mutation is idempotent when `options.apply` is
 * omitted or `false`. Pass `{ apply: true }` to trigger a reinstall.
 *
 * Invalidates the installed-packages list and the individual package-detail
 * cache on success.
 */
export function useUpdatePackage() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<UpdateResult, Error, UpdatePackageArgs>({
    mutationFn: ({ name, options }) => transport.updateMarketplacePackage(name, options),
    onSuccess: (_result, { name }) => {
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packageDetail(name) });
    },
  });
}
