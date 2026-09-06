import { useQuery } from '@tanstack/react-query';
import type { SessionConnectorStatus } from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * Fetch one session's durable connector access state. Editing moved to the
 * Connections workspace so a session cannot grant itself access.
 *
 * @param sessionId - The session to report on, or `null` to hold the query.
 */
export function useSessionConnectors(sessionId: string | null) {
  const transport = useTransport();
  return useQuery<SessionConnectorStatus>({
    queryKey: connectorKeys.session(sessionId ?? ''),
    queryFn: () => transport.getSessionConnectors(sessionId ?? ''),
    enabled: sessionId !== null && sessionId !== '',
  });
}
