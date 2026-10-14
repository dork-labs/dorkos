import { useQuery } from '@tanstack/react-query';
import { QUERY_TIMING } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';

const TOPOLOGY_KEY = ['mesh', 'topology'] as const;

/**
 * Fetch the mesh network topology filtered by namespace.
 *
 * @param namespace - Caller namespace to filter by (omit for admin view)
 * @param enabled - When false, the query is skipped entirely
 */
export function useTopology(namespace?: string, enabled = true) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...TOPOLOGY_KEY, namespace],
    queryFn: () => transport.getMeshTopology(namespace),
    enabled,
    staleTime: 30_000,
    // `agents_changed` re-reads everything under `['mesh']`; the timer is only
    // the safety net (DOR-2909).
    refetchInterval: QUERY_TIMING.EVENT_BACKSTOP_REFETCH_MS,
  });
}
