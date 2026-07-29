import { useQuery } from '@tanstack/react-query';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * Fetch every connector provider's setup state (configured, registered,
 * custody stance, disclosure copy, and the honest error text when a configured
 * provider refused to register). Drives the provider setup cards.
 */
export function useConnectorProviders() {
  const transport = useTransport();
  return useQuery<ConnectorProviderStatus[]>({
    queryKey: connectorKeys.providers(),
    queryFn: () => transport.getConnectorProviders(),
  });
}
