import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectorAgentRequestAuthenticationInput,
  ConnectorAgentRequestDecision,
} from '@dorkos/shared/connector-agent-request-schemas';
import type {
  ConnectorEveryAgentRevokeResponse,
  ConnectorAgentRequestItem,
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

/** Read owner-visible service requests raised by runtime agents. */
export function useConnectorAgentRequests(state?: 'pending' | 'resolved') {
  const transport = useTransport();
  return useQuery<ConnectorAgentRequestItem[]>({
    queryKey: connectorKeys.agentRequestList(state),
    queryFn: () => transport.getConnectorAgentRequests(state),
    // Every reader draws its own quiet fallback (the page's error state, a
    // room's empty section for someone who is not the owner), so no toast.
    meta: { suppressErrorToast: true },
  });
}

/**
 * Read every request one conversation's agent raised, for the cards drawn in
 * that conversation's transcript. Answered ones are included: a card stays in
 * the transcript as the record of what was decided.
 *
 * @param sessionId - The conversation; `null` reads nothing.
 */
export function useSessionConnectorAgentRequests(sessionId: string | null) {
  const transport = useTransport();
  return useQuery<ConnectorAgentRequestItem[]>({
    queryKey: connectorKeys.sessionAgentRequests(sessionId ?? ''),
    queryFn: () => transport.getConnectorAgentRequests(undefined, sessionId ?? ''),
    enabled: Boolean(sessionId),
    meta: { suppressErrorToast: true },
  });
}

/** Read one exact agent request for the Connections deep link. */
export function useConnectorAgentRequest(requestId: string | null) {
  const transport = useTransport();
  return useQuery<ConnectorAgentRequestItem>({
    queryKey: connectorKeys.agentRequest(requestId ?? ''),
    queryFn: () => transport.getConnectorAgentRequest(requestId ?? ''),
    enabled: requestId !== null && requestId !== '',
  });
}

/** Resolve an agent request and refresh canonical account and request views. */
export function useResolveConnectorAgentRequest() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<
    ConnectorAgentRequestItem,
    Error,
    { requestId: string; decision: ConnectorAgentRequestDecision }
  >({
    mutationFn: ({ requestId, decision }) =>
      transport.resolveConnectorAgentRequest(requestId, decision),
    meta: { suppressErrorToast: true },
    onSuccess: (result, { requestId }) => {
      queryClient.setQueryData(connectorKeys.agentRequest(requestId), result);
      // Every list, including each conversation's, so the page's Needs you strip and the
      // chat and room cards agree the moment the answer lands.
      void queryClient.invalidateQueries({
        queryKey: connectorKeys.agentRequests(),
        predicate: (query) => query.queryKey[3] !== requestId,
      });
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
    },
  });
}

/** Start account authentication durably bound to one exact agent request. */
export function useStartConnectorAgentRequestAuthentication(requestId: string | null) {
  const transport = useTransport();
  return useMutation<
    ConnectorAuthenticationFlowState,
    Error,
    ConnectorAgentRequestAuthenticationInput
  >({
    mutationFn: (input) =>
      transport.startConnectorAgentRequestAuthentication(requestId ?? '', input),
    meta: { suppressErrorToast: true },
  });
}

/** Poll the exact authentication flow associated with one owner-reviewed agent request. */
export function useConnectorAgentRequestAuthentication(
  requestId: string | null,
  flowId: string | null
) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: connectorKeys.agentRequestAuthentication(requestId ?? '', flowId ?? ''),
    queryFn: () => transport.pollConnectorAgentRequestAuthentication(requestId ?? '', flowId ?? ''),
    enabled: Boolean(requestId && flowId),
    refetchInterval: (result) => {
      const state = result.state.data?.state;
      return state === 'starting' || state === 'pending' ? 2_000 : false;
    },
    staleTime: 0,
    meta: { suppressErrorToast: true },
  });

  useEffect(() => {
    const state = query.data?.state;
    if (!state || !requestId) return;
    if (state === 'connected') {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
    }
    if (
      state === 'connected' ||
      state === 'failed' ||
      state === 'expired' ||
      state === 'start_unknown'
    ) {
      // Every request read, each conversation's list included, but not this
      // sign-in's own poll, which has already reached its answer.
      void queryClient.invalidateQueries({
        queryKey: connectorKeys.agentRequests(),
        predicate: (candidate) => candidate.queryKey[4] !== 'authentication-flow',
      });
    }
  }, [query.data?.state, queryClient, requestId]);

  return query;
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

/**
 * Stop sharing one connection with every agent, at once and without a
 * permission review, then refresh every connection read that shows it.
 */
export function useStopSharingWithEveryAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<ConnectorEveryAgentRevokeResponse, Error, { connectionId: string }>({
    mutationFn: ({ connectionId }) => transport.stopSharingConnectorWithEveryAgent(connectionId),
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
