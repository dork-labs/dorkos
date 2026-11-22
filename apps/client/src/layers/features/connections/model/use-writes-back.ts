import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectorWritesBack,
  ConnectorWritesBackChangeRequest,
} from '@dorkos/shared/connector-exclusion-schemas';
import { connectorKeys } from '@/layers/entities/connectors';
import { useTransport } from '@/layers/shared/model';

/** The switch's cache key, under the connection so a refresh of it refreshes this too. */
const writesBackKey = (connectionId: string) =>
  [...connectorKeys.connection(connectionId), 'writes-back'] as const;

/**
 * Whether an agent that only read this connected app may write back to it
 * without asking (DOR-4794). Off until the owner turns it on.
 *
 * @param connectionId - The connected app.
 */
export function useWritesBack(connectionId: string) {
  const transport = useTransport();
  return useQuery<ConnectorWritesBack>({
    queryKey: writesBackKey(connectionId),
    queryFn: () => transport.getConnectorWritesBack(connectionId),
  });
}

/**
 * Turn the switch on or off. Turning it on resolves only after "Confirm it's
 * you"; turning it off answers at once.
 *
 * @param connectionId - The connected app.
 */
export function useSetWritesBack(connectionId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: ConnectorWritesBackChangeRequest) =>
      transport.setConnectorWritesBack(connectionId, change),
    onSuccess: (done) =>
      queryClient.setQueryData<ConnectorWritesBack>(writesBackKey(connectionId), {
        connectionId: done.connectionId,
        writesBackUnasked: done.writesBackUnasked,
        writesBackAttestedAt: done.writesBackAttestedAt,
        supported: done.supported,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: writesBackKey(connectionId) }),
  });
}
