import { useQuery } from '@tanstack/react-query';
import { QUERY_TIMING } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';

/** Query-key prefix for the mesh-status cache. Exported so cross-cutting freshness bridges can invalidate it. */
export const MESH_STATUS_KEY = ['mesh', 'status'] as const;

/**
 * Fetch aggregate mesh status including agent counts and runtime breakdown.
 *
 * Polls every 30 seconds when enabled to keep status current.
 *
 * @param enabled - When false, the query is skipped entirely (Mesh feature gate).
 */
export function useMeshStatus(enabled = true) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...MESH_STATUS_KEY],
    queryFn: () => transport.getMeshStatus(),
    enabled,
    // `mesh_liveness_changed` and `agents_changed` re-read this the moment it
    // moves; the timer is only the safety net (DOR-2909).
    refetchInterval: QUERY_TIMING.EVENT_BACKSTOP_REFETCH_MS,
  });
}
