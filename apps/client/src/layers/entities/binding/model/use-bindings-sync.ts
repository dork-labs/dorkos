import { useQueryClient } from '@tanstack/react-query';
import { useEventSubscription } from '@/layers/shared/model';
import { BINDINGS_QUERY_KEY } from './use-bindings';

/**
 * Keep the binding list fresh across clients and tabs.
 *
 * The server broadcasts `relay_bindings_changed` on the unified `/api/events`
 * stream whenever a binding is created, updated, deleted, or cleaned up as an
 * orphan of a removed adapter. This hook invalidates the shared bindings query
 * so every open surface (topology graph, Connections tab, sidebar) reflects the
 * change immediately instead of waiting for a local mutation.
 *
 * Mount once near the app root. In embedded mode (Obsidian) the in-process
 * transport yields no generic events, so the subscription is an inert no-op
 * there; that surface stays consistent via each mutation's direct invalidation.
 */
export function useBindingsSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('relay_bindings_changed', () => {
    void queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
  });
}
