import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTransport } from '@/layers/shared/model';
import type { DevLinkListing } from '@dorkos/shared/marketplace-schemas';
import { extensionQueryKeys } from '@/layers/entities/extension';
import { marketplaceKeys } from '../api/query-keys';

/**
 * Every dev link and whether it is in force (DOR-2696): the folder each one
 * runs from, whether an installed copy is set aside, and when an edit last
 * reloaded it. `registryUnreadable` says the record file can't be read.
 */
export function useDevLinks() {
  const transport = useTransport();
  return useQuery<DevLinkListing>({
    queryKey: marketplaceKeys.devLinks(),
    queryFn: () => transport.listDevLinks(),
  });
}

/**
 * Refresh everything a dev link changing touches: the installed list (and,
 * under its prefix, the dev links, held-back and per-package installations),
 * the extension list (a link brings its extensions with it, an unlink
 * takes them away or puts the installed copy's back) and the slash commands a
 * plugin projects.
 *
 * The extension list is another entity's query. Read here, not in a feature,
 * because every dev-link hook needs it and they all live in this slice;
 * `entities/extension` never imports this one, so no cycle forms.
 */
export function useInvalidateDevLinkViews(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...marketplaceKeys.all, 'installed'] });
    void queryClient.invalidateQueries({ queryKey: extensionQueryKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['commands'] });
  }, [queryClient]);
}
