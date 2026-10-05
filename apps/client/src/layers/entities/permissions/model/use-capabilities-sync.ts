/**
 * Keep every permission list honest when a running extension's tools join or
 * leave the capability registry.
 *
 * @module entities/permissions/model/use-capabilities-sync
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEventSubscription } from '@/layers/shared/model';
import { permissionKeys } from './permission-keys';

/**
 * Follow `capabilities_changed` on the unified `/api/events` stream (DOR-2685).
 *
 * The server sends it whenever an extension starts or stops and its tools are
 * added to or removed from the registry. The permissions pages list each area's
 * actions from the live registry, so every permission query is re-read: a tool
 * an extension adds appears under Extension tools, and one it removes goes,
 * without a reload. The event carries only a version number.
 */
export function useCapabilitiesSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('capabilities_changed', () => {
    void queryClient.invalidateQueries({ queryKey: permissionKeys.all });
  });
}
