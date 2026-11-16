import type {
  ConnectorAgentRequestItem,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { mockConnection } from './connections';

/** Made-up account for reviewing an app with no change actions. */
export const READ_ONLY_CONNECTION = mockConnection({
  connectionId: 'linear-read-only' as never,
  toolkit: 'linear',
  label: 'Demo team',
  identityHint: 'scout@example.com',
  agentCount: 1,
});

/** A genuine read-only catalog: no destructive, paid, or unsupported change actions. */
export const READ_ONLY_ACCESS_PREVIEW: ConnectorReconciliationPreview = {
  previewId: 'preview-linear-read-only',
  connection: {
    connectionId: READ_ONLY_CONNECTION.connectionId,
    toolkit: 'linear',
    label: 'Demo team',
    status: 'active',
    custody: 'managed',
    reconciliationStatus: 'ready',
  },
  candidates: [
    {
      operationRevisionId: 'linear-read',
      toolkit: 'linear',
      operationSlug: 'linear.list_issues',
      toolkitVersion: '1',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: {},
      supported: true,
    },
  ],
  agents: [{ agentId: 'scout', displayName: 'Scout' }],
  currentGrants: [{ agentId: 'scout', operationRevisionIds: ['linear-read'], level: 'read' }],
  everyAgent: { available: true, operationRevisionIds: [] },
  catalogComplete: true,
  createdAt: '2026-11-15T00:00:00.000Z',
  expiresAt: '2099-11-15T00:00:00.000Z',
};

/** Scout asks for write access that this catalog cannot offer. */
export const READ_ONLY_AGENT_REQUEST: ConnectorAgentRequestItem = {
  requestId: 'scout-read-only',
  serviceSlug: 'linear',
  reason: 'Review and update issues',
  access: 'read-write',
  requestedEvents: [],
  note: 'The person hasn’t answered yet.',
  createdAt: '2026-11-15T00:00:00.000Z',
  expiresAt: '2099-11-15T00:00:00.000Z',
  status: 'awaiting_owner',
  sessionId: 'scout-demo',
  agent: { id: 'scout', displayName: 'Scout' },
};
