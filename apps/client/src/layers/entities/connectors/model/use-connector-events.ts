import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConfigureConnectionEventSource,
  CreateConnectionEventSubscription,
} from '@dorkos/shared/connector-event-schemas';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/** Read every requested page of immutable notification definitions for one connection. */
export function useConnectionEventDefinitions(connectionId: string | null, enabled = true) {
  const transport = useTransport();
  return useInfiniteQuery({
    queryKey: connectorKeys.eventDefinitions(connectionId ?? ''),
    queryFn: ({ pageParam }) =>
      transport.listConnectionEventDefinitions(connectionId ?? '', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: enabled && Boolean(connectionId),
  });
}

/** Read owner-visible notification subscriptions, polling only while setup is pending. */
export function useConnectionEventSubscriptions(connectionId: string | null, enabled = true) {
  const transport = useTransport();
  return useInfiniteQuery({
    queryKey: connectorKeys.eventSubscriptions(connectionId ?? ''),
    queryFn: ({ pageParam }) =>
      transport.listConnectionEventSubscriptions(connectionId ?? '', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: enabled && Boolean(connectionId),
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.subscriptions.some((subscription) => subscription.state === 'pending')
      )
        ? 2_000
        : false,
  });
}

/** Create one exact owner-approved notification subscription. */
export function useCreateConnectionEventSubscription() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      connectionId,
      input,
    }: {
      connectionId: string;
      input: CreateConnectionEventSubscription;
    }) => transport.createConnectionEventSubscription(connectionId, input),
    meta: { suppressErrorToast: true },
    onSuccess: (_subscription, { connectionId }) => {
      void queryClient.invalidateQueries({
        queryKey: connectorKeys.eventSubscriptions(connectionId),
      });
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connection(connectionId) });
    },
  });
}

/** Revoke one exact subscription without retargeting another destination. */
export function useDeleteConnectionEventSubscription() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      connectionId,
      subscriptionId,
    }: {
      connectionId: string;
      subscriptionId: string;
    }) => transport.deleteConnectionEventSubscription(connectionId, subscriptionId),
    meta: { suppressErrorToast: true },
    onSettled: async (_result, _error, { connectionId }) => {
      await queryClient.invalidateQueries({
        queryKey: connectorKeys.eventSubscriptions(connectionId),
      });
      await queryClient.invalidateQueries({ queryKey: connectorKeys.connection(connectionId) });
    },
  });
}

/** Read secret-free source setup for a supported BYO account. */
export function useConnectionEventSource(connectionId: string | null, enabled: boolean) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.eventSource(connectionId ?? ''),
    queryFn: () => transport.getConnectionEventSource(connectionId ?? ''),
    enabled: enabled && Boolean(connectionId),
  });
}

/** Submit write-only source setup and refresh its secret-free status. */
export function useConfigureConnectionEventSource() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      connectionId,
      input,
    }: {
      connectionId: string;
      input: ConfigureConnectionEventSource;
    }) => transport.configureConnectionEventSource(connectionId, input),
    meta: { suppressErrorToast: true },
    onSuccess: (status, { connectionId }) => {
      queryClient.setQueryData(connectorKeys.eventSource(connectionId), status);
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connection(connectionId) });
      void queryClient.invalidateQueries({
        queryKey: connectorKeys.eventDefinitions(connectionId),
      });
      void queryClient.invalidateQueries({
        queryKey: connectorKeys.eventSubscriptions(connectionId),
      });
    },
  });
}
