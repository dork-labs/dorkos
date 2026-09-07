import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectorAuthenticationFlowCreateRequest,
  ConnectorAuthenticationFlowState,
} from '@dorkos/shared/connector-resource-schemas';
import type { ConnectionId } from '@dorkos/shared/connector-schemas';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/** Read one bounded, account-free page from the service catalog. */
export function useConnectorCatalog(query: string) {
  const transport = useTransport();
  return useInfiniteQuery({
    queryKey: connectorKeys.catalog(query),
    queryFn: ({ pageParam }) =>
      transport.getConnectorCatalog({
        ...(query.trim() !== '' && { query: query.trim() }),
        ...(pageParam && { cursor: pageParam }),
        limit: 24,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/** Read the operator's canonical stable connection inventory. */
export function useConnectorConnections() {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.connections(),
    queryFn: () => transport.getConnectorConnections(),
  });
}

/** Read owner-visible detail for one stable connection. */
export function useConnectorConnection(connectionId: string | null, enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.connection(connectionId ?? ''),
    queryFn: () => transport.getConnectorConnection(connectionId ?? ''),
    enabled: enabled && Boolean(connectionId),
  });
}

/** Read real authority counts before a destructive disconnect. */
export function useConnectorDisconnectImpact(connectionId: string | null, enabled: boolean) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.disconnectImpact(connectionId ?? ''),
    queryFn: () => transport.getConnectorDisconnectImpact(connectionId ?? ''),
    enabled: enabled && Boolean(connectionId),
  });
}

/** Read the exact canonical connection grants for one agent profile. */
export function useAgentConnectorConnections(agentId: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.agentConnections(agentId ?? ''),
    queryFn: () => transport.getAgentConnectorConnections(agentId ?? ''),
    enabled: Boolean(agentId),
  });
}

/** Read effective canonical connection access for one session. */
export function useSessionConnectorConnections(sessionId: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.sessionConnections(sessionId ?? ''),
    queryFn: () => transport.getSessionConnectorConnections(sessionId ?? ''),
    enabled: Boolean(sessionId),
  });
}

/** Read logical operations and attempts for one owner-visible connection. */
export function useConnectorUsage(connectionId: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.usage(connectionId ?? ''),
    queryFn: () =>
      transport.getOperatorConnectorUsage({ connectionId: (connectionId ?? '') as ConnectionId }),
    enabled: Boolean(connectionId),
  });
}

/** Start one durable owner authentication flow. */
export function useStartConnectorAuthentication() {
  const transport = useTransport();
  return useMutation<
    ConnectorAuthenticationFlowState,
    Error,
    ConnectorAuthenticationFlowCreateRequest
  >({
    mutationFn: (input) => transport.startConnectorAuthentication(input),
    meta: { suppressErrorToast: true },
  });
}

/** Poll one URL-selected durable authentication flow until it reaches a terminal state. */
export function useConnectorAuthentication(flowId: string | null) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: connectorKeys.authenticationFlow(flowId ?? ''),
    queryFn: () => transport.pollConnectorAuthentication(flowId ?? ''),
    enabled: Boolean(flowId),
    refetchInterval: (result) => {
      const state = result.state.data?.state;
      return state === 'starting' || state === 'pending' ? 2_000 : false;
    },
    staleTime: 0,
    meta: { suppressErrorToast: true },
  });

  useEffect(() => {
    if (query.data?.state !== 'connected') return;
    void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
  }, [query.data?.state, queryClient]);

  return query;
}

function useConnectionMutation<TInput, TResult = unknown>(
  run: (connectionId: string, input: TInput) => Promise<TResult>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, input }: { connectionId: string; input: TInput }) =>
      run(connectionId, input),
    meta: { suppressErrorToast: true },
    onSettled: (_data, _error, { connectionId }) => {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connection(connectionId) });
    },
  });
}

/** Rename a connection using its local presentation label. */
export function useRenameConnectorConnection() {
  const transport = useTransport();
  return useConnectionMutation<{ label: string }>((connectionId, input) =>
    transport.renameConnectorConnection(connectionId, input)
  );
}

/** Start a durable reconnect flow for one stable connection. */
export function useReconnectConnectorConnection() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId }: { connectionId: string }) =>
      transport.reconnectConnectorConnection(connectionId, {
        idempotencyKey: crypto.randomUUID(),
      }),
    meta: { suppressErrorToast: true },
    onSettled: (_data, _error, { connectionId }) => {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connection(connectionId) });
    },
  });
}

/** Pause a connection and close its usable authority. */
export function usePauseConnectorConnection() {
  const transport = useTransport();
  return useConnectionMutation<void>((connectionId) =>
    transport.pauseConnectorConnection(connectionId)
  );
}

/** Resume a connection after its current authority is valid. */
export function useResumeConnectorConnection() {
  const transport = useTransport();
  return useConnectionMutation<void>((connectionId) =>
    transport.resumeConnectorConnection(connectionId)
  );
}

/** Disconnect a connection after the operator reviews its impact. */
export function useDisconnectConnectorConnection() {
  const transport = useTransport();
  return useConnectionMutation<void>((connectionId) =>
    transport.disconnectConnectorConnection(connectionId)
  );
}
