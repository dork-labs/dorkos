import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectorManagementReviewDecision,
  ConnectorManagementReviewDecisionResult,
  ConnectorManagementReviewItem,
  ConnectorReconciliationApplyRequest,
  ConnectorReconciliationApplyResponse,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorAuthenticationFlowState } from '@dorkos/shared/connector-resource-schemas';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/** Read owner-visible connector management requests by lifecycle group. */
export function useConnectorManagementReviews(state?: 'pending' | 'resolved') {
  const transport = useTransport();
  return useQuery<ConnectorManagementReviewItem[]>({
    queryKey: connectorKeys.reviewList(state),
    queryFn: () => transport.getConnectorManagementReviews(state),
  });
}

/** Read one exact owner-visible management request for a URL deep link. */
export function useConnectorManagementReview(reviewRequestId: string | null) {
  const transport = useTransport();
  return useQuery<ConnectorManagementReviewItem>({
    queryKey: connectorKeys.review(reviewRequestId ?? ''),
    queryFn: () => transport.getConnectorManagementReview(reviewRequestId ?? ''),
    enabled: reviewRequestId !== null && reviewRequestId !== '',
  });
}

/** Resolve one pending request, then refresh its detail and both lifecycle lists. */
export function useResolveConnectorManagementReview() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<
    ConnectorManagementReviewDecisionResult,
    Error,
    { reviewRequestId: string; decision: ConnectorManagementReviewDecision['decision'] }
  >({
    mutationFn: ({ reviewRequestId, decision }) =>
      transport.resolveConnectorManagementReview(reviewRequestId, { decision }),
    meta: { suppressErrorToast: true },
    onSuccess: (result, { reviewRequestId }) => {
      queryClient.setQueryData(connectorKeys.review(reviewRequestId), result.review);
      void queryClient.invalidateQueries({ queryKey: connectorKeys.reviewList('pending') });
      void queryClient.invalidateQueries({ queryKey: connectorKeys.reviewList('resolved') });
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
    },
  });
}

/** Create one complete, expiring permission snapshot for an owned connection. */
export function usePreviewConnectorReconciliation() {
  const transport = useTransport();
  return useMutation<ConnectorReconciliationPreview, Error, { connectionId: string }>({
    mutationFn: ({ connectionId }) =>
      transport.previewConnectorReconciliation({
        connectionId: connectionId as ConnectorReconciliationPreview['connection']['connectionId'],
      }),
    meta: { suppressErrorToast: true },
  });
}

/** Apply only explicitly changed agents from one immutable permission snapshot. */
export function useApplyConnectorReconciliation() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<
    ConnectorReconciliationApplyResponse,
    Error,
    ConnectorReconciliationApplyRequest
  >({
    mutationFn: (input) => transport.applyConnectorReconciliation(input),
    meta: { suppressErrorToast: true },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
    },
  });
}

/** Poll an approved connect request's opaque authentication flow after the owner opens it. */
export function useConnectorReviewAuthentication(flowId: string | null, enabled: boolean) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const query = useQuery<ConnectorAuthenticationFlowState>({
    queryKey: connectorKeys.authenticationFlow(flowId ?? ''),
    queryFn: () => transport.pollConnectorAuthentication(flowId ?? ''),
    enabled: enabled && flowId !== null && flowId !== '',
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'starting' || state === 'pending' ? 2_000 : false;
    },
    staleTime: 0,
    gcTime: 0,
    meta: { suppressErrorToast: true },
  });

  useEffect(() => {
    if (query.data?.state === 'connected') {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
    }
  }, [query.data?.state, queryClient]);

  return query;
}
