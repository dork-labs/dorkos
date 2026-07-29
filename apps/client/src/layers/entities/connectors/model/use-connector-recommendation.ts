import { useQuery } from '@tanstack/react-query';
import type { ConnectorRecommendationsResponse } from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * Ask how a service should be connected, best route first. The service grid's
 * Connect verb routes through this so the provider choice stays invisible: a
 * relay-adapter recommendation deep-links to the relay surface, a
 * gateway/raw-mcp one starts the connect flow on that provider.
 *
 * @param service - Service slug, or `null` to hold the query (dialog closed).
 */
export function useConnectorRecommendation(service: string | null) {
  const transport = useTransport();
  return useQuery<ConnectorRecommendationsResponse>({
    queryKey: connectorKeys.recommendation(service ?? ''),
    queryFn: () => transport.getConnectorRecommendation(service ?? ''),
    enabled: service !== null,
  });
}
