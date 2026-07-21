import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Query-key prefix for the mesh-status cache. Exported so cross-cutting freshness bridges can invalidate it. */
export const MESH_STATUS_KEY = ['mesh', 'status'] as const;

/** Polling interval for mesh status refresh (30 seconds). */
const STATUS_REFETCH_INTERVAL = 30_000;

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
    refetchInterval: STATUS_REFETCH_INTERVAL,
  });
}
