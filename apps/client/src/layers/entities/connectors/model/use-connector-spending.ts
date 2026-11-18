import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SpendingSummary } from '@dorkos/shared/connector-spending';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * This month's spend limit, prices and spending (DOR-4204 PR 2).
 *
 * @param options - `enabled` skips the read where nothing can spend.
 */
export function useConnectorSpending(options: { enabled?: boolean } = {}) {
  const transport = useTransport();
  return useQuery<SpendingSummary>({
    queryKey: connectorKeys.spending(),
    queryFn: () => transport.getConnectorSpending(),
    enabled: options.enabled ?? true,
  });
}

/**
 * Set, lower or clear the monthly limit, in micro-units. A first or higher
 * limit resolves only after "Confirm it's you".
 */
export function useSetSpendingLimit() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (limitMicro: string | null) => transport.setConnectorSpendingLimit(limitMicro),
    onSuccess: (summary) => queryClient.setQueryData(connectorKeys.spending(), summary),
    onSettled: () => queryClient.invalidateQueries({ queryKey: connectorKeys.spending() }),
  });
}

/**
 * Set or clear an app's price per run, in micro-units. A first or lower price
 * resolves only after "Confirm it's you".
 */
export function useSetSpendingPrice() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ toolkit, priceMicro }: { toolkit: string; priceMicro: string | null }) =>
      transport.setConnectorSpendingPrice(toolkit, priceMicro),
    onSuccess: (summary) => queryClient.setQueryData(connectorKeys.spending(), summary),
    onSettled: () => queryClient.invalidateQueries({ queryKey: connectorKeys.spending() }),
  });
}
