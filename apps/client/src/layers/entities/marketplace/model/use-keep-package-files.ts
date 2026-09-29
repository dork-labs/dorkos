import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { KeepFilesOptions, KeepFilesResult } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/** Arguments passed to the keep-files mutation. */
export interface KeepPackageFilesArgs {
  /** Installed package name. */
  name: string;
  /** The installation, the key it was shown with, and any review it was shown. */
  options: KeepFilesOptions;
}

/**
 * "Keep these as mine" for the files an update kept but nothing could sort
 * (DOR-2341). Moves and deletes nothing. Refreshes the installed list (and so
 * the row's integrity and whether the package is held back) either way.
 */
export function useKeepPackageFiles() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<KeepFilesResult, Error, KeepPackageFilesArgs>({
    mutationFn: ({ name, options }) => transport.keepPackageFiles(name, options),
    // The caller reports the outcome in a toast of its own.
    meta: { suppressErrorToast: true },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
    },
  });
}
