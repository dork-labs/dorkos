import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { AdapterListItem } from '@dorkos/shared/transport';

const ADAPTERS_KEY = ['relay', 'adapters'] as const;

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
  });
}

/**
 * Mutation to enable or disable a Relay adapter by ID.
 * Invalidates the adapter list query on success.
 */
export function useToggleAdapter() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      transport.toggleRelayAdapter(id, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] }),
  });
}
