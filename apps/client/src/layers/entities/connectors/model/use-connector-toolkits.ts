import { useQuery } from '@tanstack/react-query';
import type { ConnectorToolkitsResponse } from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * Fetch the connectable services aggregated across every registered provider,
 * with per-provider degradation warnings. Drives the service-first grid.
 */
export function useConnectorToolkits() {
  const transport = useTransport();
  return useQuery<ConnectorToolkitsResponse>({
    queryKey: connectorKeys.toolkits(),
    queryFn: () => transport.getConnectorToolkits(),
  });
}
