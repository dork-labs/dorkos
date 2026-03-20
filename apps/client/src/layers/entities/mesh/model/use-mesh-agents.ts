import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

const AGENTS_KEY = ['mesh', 'agents'] as const;

/**
 * Fetch all registered mesh agents with optional filters.
 *
 * @param filters - Optional runtime or capability filters.
 * @param enabled - When false, the query is skipped entirely (Mesh feature gate).
 */
export function useRegisteredAgents(
  filters?: { runtime?: string; capability?: string },
  enabled = true
) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...AGENTS_KEY, filters],
    queryFn: () => transport.listMeshAgents(filters),
    enabled,
    staleTime: 30_000,
  });
}
