import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport, useEventSubscription } from '@/layers/shared/model';
import type { AdapterListItem } from '@dorkos/shared/transport';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';

const ADAPTERS_KEY = ['relay', 'adapters'] as const;
const CATALOG_KEY = ['relay', 'adapters', 'catalog'] as const;

/**
 * Fetch all Relay adapter configs and live statuses with 10-second polling.
 *
 * @param enabled - When false, the query is skipped entirely (Relay feature gate).
 */
export function useRelayAdapters(enabled = true) {
  const transport = useTransport();

  return useQuery<AdapterListItem[]>({
    queryKey: [...ADAPTERS_KEY],
    queryFn: () => transport.listRelayAdapters(),
    enabled,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Mutation to enable or disable a Relay adapter by ID.
 * Uses optimistic updates on the catalog cache for instant feedback,
 * reverting on failure.
 */
export function useToggleAdapter() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      transport.toggleRelayAdapter(id, enabled),
    onMutate: async ({ id, enabled }) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update.
      await queryClient.cancelQueries({ queryKey: [...CATALOG_KEY] });

      const previousCatalog = queryClient.getQueryData<CatalogEntry[]>([...CATALOG_KEY]);

      // Optimistically update the catalog cache.
      if (previousCatalog) {
        queryClient.setQueryData<CatalogEntry[]>([...CATALOG_KEY], (old) =>
          old?.map((entry) => ({
            ...entry,
            instances: entry.instances.map((inst) =>
              inst.id === id ? { ...inst, enabled } : inst
            ),
          }))
        );
      }

      return { previousCatalog };
    },
    onError: (_error, _variables, context) => {
      // Revert optimistic update on failure.
      if (context?.previousCatalog) {
        queryClient.setQueryData([...CATALOG_KEY], context.previousCatalog);
      }
      toast.error('Failed to toggle adapter');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
      queryClient.invalidateQueries({ queryKey: [...CATALOG_KEY] });
    },
  });
}

/**
 * Keep adapter configs and live statuses fresh across clients and tabs.
 *
 * The server broadcasts `relay_adapters_changed` on the unified `/api/events`
 * stream on every adapter connect/disconnect and config change. This hook
 * invalidates the adapter list and catalog (a prefix match on
 * `['relay','adapters']` covers both) so status flips appear immediately rather
 * than on the next 10s poll.
 *
 * Mount once near the app root. In embedded mode (Obsidian) the in-process
 * transport yields no generic events, so the subscription is an inert no-op.
 */
export function useRelayAdaptersSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('relay_adapters_changed', () => {
    void queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
  });
}
