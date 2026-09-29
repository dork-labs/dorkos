import { useQuery } from '@tanstack/react-query';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import type {
  ConnectorAppConnections,
  ConnectorProvidersResource,
} from '@dorkos/shared/connector-resource-schemas';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/** The one read both hooks below project from, so they share a single request. */
function useProvidersResource<T>(select: (resource: ConnectorProvidersResource) => T) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.providers(),
    queryFn: () => transport.getConnectorProviders(),
    select,
  });
}

const selectProviders = (resource: ConnectorProvidersResource) => resource.providers;
const selectAppConnections = (resource: ConnectorProvidersResource) => resource.appConnections;

/**
 * Fetch every connector provider's setup state (configured, registered,
 * custody stance, disclosure copy, and the honest error text when a configured
 * provider refused to register). Drives the provider setup cards.
 */
export function useConnectorProviders() {
  return useProvidersResource<ConnectorProviderStatus[]>(selectProviders);
}

/**
 * How DorkOS reaches apps right now: every way set up, and the one new apps
 * use. Read from the same response as {@link useConnectorProviders}.
 */
export function useConnectorAppConnections() {
  return useProvidersResource<ConnectorAppConnections>(selectAppConnections);
}
