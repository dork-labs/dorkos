/** Shared fixtures for the owner-management dialogs: a reconciliation preview, a pending pause and a renderer. */
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectorManagementReviewItem,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { TransportProvider } from '@/layers/shared/model';

export const PREVIEW: ConnectorReconciliationPreview = {
  previewId: 'preview-1',
  connection: {
    connectionId: 'connection-1' as never,
    toolkit: 'gmail',
    label: 'Gmail (work)',
    status: 'active',
    custody: 'managed',
    reconciliationStatus: 'ready',
  },
  candidates: [
    {
      operationRevisionId: 'read-v1',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.list',
      toolkitVersion: '2026-08-01',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: {},
      supported: true,
    },
    {
      operationRevisionId: 'write-v2',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.send',
      toolkitVersion: '2026-09-01',
      capabilityClassification: 'write',
      retryPolicy: 'provider_idempotency_key',
      inputSchema: {},
      supported: true,
    },
    {
      operationRevisionId: 'delete-v2',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.delete',
      toolkitVersion: '2026-09-01',
      capabilityClassification: 'destructive',
      retryPolicy: 'never',
      inputSchema: {},
      supported: true,
    },
  ],
  agents: [
    { agentId: 'agent-a', displayName: 'Ada' },
    { agentId: 'agent-b', displayName: 'Bo' },
  ],
  currentGrants: [{ agentId: 'agent-a', operationRevisionIds: ['read-v1'] }],
  everyAgent: { available: false, operationRevisionIds: [] },
  catalogComplete: true,
  createdAt: '2026-09-06T00:00:00.000Z',
  expiresAt: '2099-09-06T01:00:00.000Z',
};

export const CONNECTION_CONTEXT = {
  connectionId: 'connection-1' as never,
  label: 'Gmail (work)',
  toolkit: 'gmail',
  status: 'active' as const,
  custody: 'managed' as const,
  providerDisplayName: 'Composio',
  providerStatus: 'available' as const,
  reconciliationStatus: 'ready' as const,
};

export const PENDING_PAUSE: ConnectorManagementReviewItem = {
  reviewRequestId: 'review-pause',
  requesterKind: 'program',
  action: { version: 1, kind: 'pause', connectionId: 'connection-1' as never },
  context: {
    kind: 'pause',
    connection: CONNECTION_CONTEXT,
  },
  targetStatus: 'available',
  state: 'pending',
  createdAt: '2026-09-06T00:00:00.000Z',
  expiresAt: '2099-09-06T01:00:00.000Z',
};

export function renderWith(transport: Transport, ui: ReactNode): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}
