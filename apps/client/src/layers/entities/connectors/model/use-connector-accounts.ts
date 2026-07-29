import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectorAccountsResponse } from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * Fetch the connected accounts across every provider, each row carrying its
 * server-composed custody sentence.
 *
 * @param toolkit - Optional service slug to filter to.
 */
export function useConnectorAccounts(toolkit?: string) {
  const transport = useTransport();
  return useQuery<ConnectorAccountsResponse>({
    queryKey: connectorKeys.accountList(toolkit),
    queryFn: () => transport.getConnectorAccounts(toolkit),
  });
}

/**
 * Disconnect (revoke) one connected account. Invalidates the account
 * aggregates and every session's connector surface — a disconnected account
 * may have been attached anywhere.
 */
export function useDisconnectConnectorAccount() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<void, Error, { accountId: string }>({
    mutationFn: ({ accountId }) => transport.disconnectConnectorAccount(accountId),
    meta: { errorLabel: "Couldn't disconnect the account" },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.accounts() });
      void queryClient.invalidateQueries({ queryKey: connectorKeys.sessions() });
    },
  });
}
