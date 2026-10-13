import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport, useEventSubscription } from '@/layers/shared/model';
import type { AdapterListItem } from '@dorkos/shared/transport';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';

const ADAPTERS_KEY = ['relay', 'adapters'] as const;

const CATALOG_KEY = ['relay', 'adapters', 'catalog'] as const;

/**
 * How often the adapter list checks again with no event. Faster than the shared
 * backstop because one change still has no event: a chat app's connection
 * failing on its own (recorded inside the adapter, never broadcast), which the
 * health dot should show within half a minute (DOR-2909). DOR-2911 adds that
 * event; then this joins the shared one-minute backstop.
 */
const ADAPTERS_BACKSTOP_MS = 30_000;

/**
 * Fetch all Relay adapter configs and live statuses, kept current by
 * {@link useRelayAdaptersSync} with a slow poll behind it.
 *
 * @param enabled - When false, the query is skipped entirely (Relay feature gate).
 */
export function useRelayAdapters(enabled = true) {
  const transport = useTransport();

  return useQuery<AdapterListItem[]>({
    queryKey: [...ADAPTERS_KEY],
    queryFn: () => transport.listRelayAdapters(),
    enabled,
    // `relay_adapters_changed` (`useRelayAdaptersSync`) is the real update; this
    // only catches the changes the server does not announce.
    refetchInterval: ADAPTERS_BACKSTOP_MS,
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
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
      queryClient.invalidateQueries({ queryKey: [...CATALOG_KEY] });
    },
    // The shared mutation toast (`query-client.ts`) reports the failure now
    // — this used to show its own on top of it.
    meta: { errorLabel: 'Couldn’t turn that connection on or off' },
  });
}

/**
 * Keep adapter statuses fresh across clients and tabs.
 *
 * The server broadcasts `relay_adapters_changed` on the unified `/api/events`
 * stream on connection-state transitions of enabled adapters
 * (connect/disconnect). This hook invalidates the adapter list and catalog (a
 * prefix match on `['relay','adapters']` covers both) so those flips appear
 * immediately. Config-only edits, changes to disabled adapters, and silent
 * in-adapter drops do not broadcast — the 30s poll backstops them.
 */
export function useRelayAdaptersSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('relay_adapters_changed', () => {
    void queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
  });
}
