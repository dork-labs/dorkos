import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectorAuthenticationFlowCreateRequest,
  ConnectorAuthenticationFlowState,
  ConnectorLifecycleResult,
} from '@dorkos/shared/connector-resource-schemas';
import type { ConnectionId } from '@dorkos/shared/connector-schemas';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * How long catalog pages are reused before they are fetched again. The server
 * already keeps each service's app list, so a few minutes spares a request on
 * every mount. Saving or removing a key, and linking or unlinking a DorkOS
 * account, invalidate the whole connector scope, so a change in setup never
 * waits this out.
 */
const CONNECTOR_CATALOG_STALE_TIME_MS = 5 * 60 * 1000;

/** Read one bounded, account-free page from the service catalog. */
export function useConnectorCatalog(query: string, enabled = true) {
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
    // A page that came back with a warning (a service that could not list its
    // apps) is never reused: the next mount asks again, so it can recover.
    staleTime: (query) =>
      query.state.data?.pages.some((page) => page.warnings.length > 0)
        ? 0
        : CONNECTOR_CATALOG_STALE_TIME_MS,
    enabled,
  });
}

/** How long the browser treats an app's action list as current; the server keeps it for a day. */
const APP_ACTIONS_STALE_MS = 5 * 60_000;

/**
 * Read what one app lets agents do through one configured way. Nothing is
 * asked for until both are known, and a reopened panel shows the kept list
 * at once.
 *
 * @param toolkit - The app's service id, e.g. `gmail`.
 * @param providerInstanceId - The way that reaches it, or `null` when none is set up.
 */
export function useConnectorAppActions(toolkit: string, providerInstanceId: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.appActions(providerInstanceId ?? '', toolkit),
    queryFn: () => transport.getConnectorAppActions(toolkit, providerInstanceId ?? ''),
    enabled: Boolean(providerInstanceId) && toolkit !== '',
    staleTime: APP_ACTIONS_STALE_MS,
  });
}

/**
 * Check again whether the DorkOS account can reach apps. Reading the catalog
 * is what makes the server try the DorkOS account's route again when it isn't
 * registered, so this reads one page of it first, then every connector read
 * again, so the accounts show what that check found.
 */
export function useRecheckConnectorWays() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => transport.getConnectorCatalog({ limit: 1 }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
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

/**
 * How often a disconnected account whose sign-out is still finishing re-reads
 * its detail. The server keeps retrying on its own; this only keeps the panel
 * honest about it, and stops the moment the sign-out settles or is refused.
 */
const CLEANUP_PENDING_REFRESH_MS = 15_000;

/** Read owner-visible detail for one stable connection. */
export function useConnectorConnection(connectionId: string | null, enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.connection(connectionId ?? ''),
    queryFn: () => transport.getConnectorConnection(connectionId ?? ''),
    enabled: enabled && Boolean(connectionId),
    refetchInterval: (query) => {
      // Only while DorkOS is actually retrying: a refused or stuck disconnect
      // waits on the owner, and re-reading it would change nothing.
      return query.state.data?.connection.readiness.reason === 'disconnect_finishing'
        ? CLEANUP_PENDING_REFRESH_MS
        : false;
    },
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

/**
 * Read what every agent, including one not created yet, inherits from the
 * owner's every-agent grants. Lives under the connections key, so any grant
 * change that refreshes connections refreshes this too.
 */
export function useEveryAgentConnectorGrants(enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.everyAgentGrants(),
    queryFn: () => transport.getEveryAgentConnectorGrants(),
    enabled,
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
  return useConnectionMutation<void, ConnectorLifecycleResult>((connectionId) =>
    transport.disconnectConnectorConnection(connectionId)
  );
}

/** Remove a disconnected account from the visible owner inventory. */
export function useRemoveConnectorConnection() {
  const transport = useTransport();
  return useConnectionMutation<void>((connectionId) =>
    transport.removeConnectorConnection(connectionId)
  );
}

/**
 * Turn one app on or off for one chat's agent. The server answers with the
 * chat's access as it now stands, so the chat's list shows the server's
 * readiness straight away and is never guessed here.
 *
 * @param sessionId - The chat whose access changes.
 */
export function useSetSessionConnectorAccess(sessionId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, on }: { connectionId: string; on: boolean }) =>
      transport.setSessionConnectorAccess(sessionId, connectionId, { on }),
    meta: { suppressErrorToast: true },
    onSuccess: (data) => {
      queryClient.setQueryData(connectorKeys.sessionConnections(sessionId), data);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: connectorKeys.sessionConnections(sessionId),
      });
    },
  });
}
