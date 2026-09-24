import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RefreshedMarketplaceSource } from '@dorkos/shared/marketplace-schemas';
import { useTransport } from '@/layers/shared/model';
import { marketplaceKeys } from '../api/query-keys';

/**
 * Fetch a marketplace source's listing again, the app's `dorkos marketplace
 * refresh <name>`.
 *
 * Invalidates the all-packages browse cache on success, since the source's
 * packages may have changed (or, after a failed first fetch, appeared).
 *
 * A failure does not raise the app-wide error toast: the caller shows the
 * server's reason where the source is (the sources page puts it on the row).
 *
 * @returns A mutation keyed by source name; its error message is the server's
 *   plain-words reason the listing could not be fetched.
 */
export function useRefreshMarketplaceSource() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<RefreshedMarketplaceSource, Error, string>({
    mutationFn: (name) => transport.refreshMarketplaceSource(name),
    meta: { suppressErrorToast: true },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packages() });
    },
  });
}
