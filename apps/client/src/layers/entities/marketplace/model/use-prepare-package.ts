import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { PrepareOptions, PrepareResult } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/** Arguments passed to the prepare mutation. */
export interface PreparePackageArgs {
  /** Installed package name. */
  name: string;
  /** The one installation to prepare, and its scope. */
  options?: PrepareOptions;
}

/**
 * Prepare a package an older DorkOS installed: record which of its files are
 * the package's, from the exact commit it was installed at (DOR-2320). The
 * server writes only on an exact match and otherwise says why; either way the
 * verified list is refreshed so the row shows where it stands now.
 */
export function usePreparePackage() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<PrepareResult, Error, PreparePackageArgs>({
    mutationFn: ({ name, options }) => transport.prepareMarketplacePackage(name, options),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.integrity() });
    },
  });
}
