import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { InstallOptions, InstallResult } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/** Arguments passed to the install mutation. */
export interface InstallPackageArgs {
  /** Package name (e.g. `@org/my-plugin`). */
  name: string;
  /** Optional install flags (force, yes, marketplace, source, projectPath). */
  options?: InstallOptions;
}

/**
 * Install a marketplace package.
 *
 * Invalidates the installed-packages list, the all-packages browse cache, and
 * the individual package-detail cache on success so the UI reflects the new
 * installed state without a manual refresh.
 */
export function useInstallPackage() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<InstallResult, Error, InstallPackageArgs>({
    mutationFn: ({ name, options }) => transport.installMarketplacePackage(name, options),
    onSuccess: (_result, { name, options }) => {
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
      if (options?.projectPath) {
        void queryClient.invalidateQueries({
          queryKey: marketplaceKeys.installed(options.projectPath),
        });
      }
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packages() });
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packageDetail(name) });
      // Installing a plugin can register new slash commands (e.g. `/flow:*`).
      // The server hot-reloads them and broadcasts `commands_changed`, but
      // invalidate here too so the palette catches up even when the SSE event
      // is missed or the in-process (Obsidian) transport yields no events (UX-12).
      void queryClient.invalidateQueries({ queryKey: ['commands'] });
    },
  });
}
