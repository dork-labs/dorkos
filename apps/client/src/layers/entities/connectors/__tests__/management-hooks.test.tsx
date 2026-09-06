/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorManagementReviewItem } from '@dorkos/shared/connector-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  connectorKeys,
  useApplyConnectorReconciliation,
  useConnectorManagementReview,
  useConnectorManagementReviews,
  usePreviewConnectorReconciliation,
  useResolveConnectorManagementReview,
} from '../index';

const REVIEW: ConnectorManagementReviewItem = {
  reviewRequestId: 'review-1',
  requesterKind: 'program',
  action: { version: 1, kind: 'pause', connectionId: 'connection-1' as never },
  context: {
    kind: 'pause',
    connection: {
      connectionId: 'connection-1' as never,
      label: 'Gmail (work)',
      toolkit: 'gmail',
      status: 'active',
      custody: 'managed',
      providerDisplayName: 'Composio',
      providerStatus: 'available',
      reconciliationStatus: 'ready',
    },
  },
  targetStatus: 'available',
  state: 'pending',
  createdAt: '2026-09-06T00:00:00.000Z',
  expiresAt: '2026-09-06T01:00:00.000Z',
};

function wrapperFor(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('connector owner-management hooks', () => {
  it('keeps the review list and exact deep-link detail on separate keys', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReviews).mockResolvedValue([REVIEW]);
    vi.mocked(transport.getConnectorManagementReview).mockResolvedValue(REVIEW);
    const { wrapper } = wrapperFor(transport);

    const list = renderHook(() => useConnectorManagementReviews('pending'), { wrapper });
    const detail = renderHook(() => useConnectorManagementReview('review-1'), { wrapper });

    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    expect(transport.getConnectorManagementReviews).toHaveBeenCalledWith('pending');
    expect(transport.getConnectorManagementReview).toHaveBeenCalledWith('review-1');
  });

  it('replaces the resolved detail and invalidates owner lists after a decision', async () => {
    const transport = createMockTransport();
    const denied: ConnectorManagementReviewItem = {
      ...REVIEW,
      state: 'denied',
      resolvedAt: '2026-09-06T00:10:00.000Z',
      resolution: { kind: 'denied' },
    };
    vi.mocked(transport.resolveConnectorManagementReview).mockResolvedValue({ review: denied });
    const { queryClient, wrapper } = wrapperFor(transport);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useResolveConnectorManagementReview(), { wrapper });

    result.current.mutate({ reviewRequestId: 'review-1', decision: 'denied' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(connectorKeys.review('review-1'))).toEqual(denied);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: connectorKeys.reviewList('pending') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: connectorKeys.reviewList('resolved') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: connectorKeys.sessions() });
  });

  it('previews one stable connection and submits an exact named-agent replacement', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue({
      previewId: 'preview-1',
    } as never);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1',
      reconciliationStatus: 'ready',
      grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
    } as never);
    const { queryClient, wrapper } = wrapperFor(transport);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const preview = renderHook(() => usePreviewConnectorReconciliation(), { wrapper });
    const apply = renderHook(() => useApplyConnectorReconciliation(), { wrapper });

    preview.result.current.mutate({ connectionId: 'connection-1' });
    await waitFor(() => expect(preview.result.current.isSuccess).toBe(true));
    expect(transport.previewConnectorReconciliation).toHaveBeenCalledWith({
      connectionId: 'connection-1',
    });

    apply.result.current.mutate({
      previewId: 'preview-1',
      grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
    });
    await waitFor(() => expect(apply.result.current.isSuccess).toBe(true));
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
      previewId: 'preview-1',
      grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: connectorKeys.sessions() });
  });
});
