import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { SubagentInfo } from '@dorkos/shared/types';

/** Fetch available subagents from the server. Long staleTime since agents rarely change. */
export function useSubagents() {
  const transport = useTransport();

  return useQuery<SubagentInfo[]>({
    queryKey: ['subagents'],
    queryFn: () => transport.getSubagents(),
    staleTime: 30 * 60 * 1000,
  });
}
