/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConnectorAgentRequestItem,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockConnectionReadiness, createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentRequestDialog } from '../ui/AgentRequestDialog';

afterEach(cleanup);

const REQUEST: ConnectorAgentRequestItem = {
  requestId: 'request-1',
  serviceSlug: 'gmail',
  reason: 'Summarize new mail and prepare replies.',
  access: 'read-write',
  requestedEvents: [],
  createdAt: '2026-09-07T12:00:00.000Z',
  expiresAt: '2099-09-07T14:00:00.000Z',
  note: 'The person hasn’t answered yet.',
  status: 'awaiting_owner',
  sessionId: 'session-1',
  agent: { id: 'agent-1', displayName: 'Researcher' },
};

const CONNECTION = {
  connectionId: 'connection-1' as never,
  providerInstanceId: 'provider-1' as never,
  toolkit: 'gmail',
  label: 'Work mail',
  identityHint: 'r•••@example.com',
  lifecycle: 'connected' as const,
  authenticationStatus: 'active' as const,
  reconciliationStatus: 'ready' as const,
  authoritySync: { status: 'ready' as const },
  mode: 'byo' as const,
  custody: 'managed' as const,
  payer: 'operator_byo' as const,
  agentCount: 0,
  everyAgent: null,
  subscriptionCount: 0,
  usage: { status: 'available' as const, logicalOperationCount: 0, attemptCount: 0 },
  readiness: createMockConnectionReadiness(),
};

function preview(
  currentGrants: ConnectorReconciliationPreview['currentGrants'] = []
): ConnectorReconciliationPreview {
  return {
    previewId: 'preview-1',
    connection: {
      connectionId: 'connection-1' as never,
      toolkit: 'gmail',
      label: 'Work mail',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [
      ['read-v1', 'gmail.messages.list', 'read'],
      ['write-v1', 'gmail.messages.send', 'write'],
      ['delete-v1', 'gmail.messages.delete', 'destructive'],
    ].map(([operationRevisionId, operationSlug, capabilityClassification]) => ({
      operationRevisionId: operationRevisionId!,
      toolkit: 'gmail',
      operationSlug: operationSlug!,
      toolkitVersion: '1',
      capabilityClassification: capabilityClassification as 'read' | 'write' | 'destructive',
      retryPolicy: 'never' as const,
      inputSchema: {},
      supported: true,
    })),
    agents: [{ agentId: 'agent-1', displayName: 'Researcher' }],
    currentGrants,
    everyAgent: { available: false, operationRevisionIds: [] },
    catalogComplete: true,
    createdAt: '2026-09-07T12:00:00.000Z',
    expiresAt: '2099-09-07T12:05:00.000Z',
  };
}

function transportFor(request: ConnectorAgentRequestItem = REQUEST): Transport {
  const transport = createMockTransport();
  vi.mocked(transport.getConnectorAgentRequest).mockResolvedValue(request);
  vi.mocked(transport.getConnectorConnections).mockResolvedValue({ connections: [CONNECTION] });
  vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
    services: [
      {
        serviceSlug: 'gmail',
        displayName: 'Gmail',
        iconKey: 'gmail',
        intents: [{ kind: 'account', displayName: 'Use a Gmail account', routes: [] }],
      },
    ],
    warnings: [],
  });
  vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
  vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
    connectionId: 'connection-1' as never,
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    grants: [{ agentId: 'agent-1', operationRevisionIds: ['read-v1', 'write-v1'] }],
  });
  vi.mocked(transport.resolveConnectorAgentRequest).mockImplementation(
    async (_id, decision): Promise<ConnectorAgentRequestItem> =>
      decision.decision === 'denied'
        ? { ...REQUEST, status: 'denied' }
        : {
            ...REQUEST,
            status: 'granted',
            connectionId: decision.connectionId as never,
            grantedOperationRevisionIds: ['read-v1', 'write-v1'],
            grantedEvents: [],
            notGranted: [],
          }
  );
  return transport;
}

function renderDialog(transport: Transport, onEditExactActions?: (id: string) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <AgentRequestDialog
          requestId="request-1"
          open
          onOpenChange={() => undefined}
          {...(onEditExactActions ? { onEditExactActions } : {})}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('AgentRequestDialog', () => {
  it('is the chat’s own card, starting on the level the agent asked for', async () => {
    const user = userEvent.setup();
    const transport = transportFor();
    renderDialog(transport);

    const dialog = await screen.findByTestId('agent-request-dialog');
    expect(
      await within(dialog).findByRole('heading', { name: 'Let Researcher use Gmail?' })
    ).toBeVisible();
    expect(within(dialog).getByTestId('requested-access')).toHaveTextContent(
      'It wants to read and change things in Gmail.'
    );
    expect(within(dialog).getByRole('radio', { name: 'Read and write' })).toBeChecked();
    // No per-action checklist, raw badges or a second set of buttons.
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Grant access' })).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'current_access',
        connectionId: 'connection-1',
        eventScopes: [],
      })
    );
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
      previewId: 'preview-1',
      grants: [{ agentId: 'agent-1', operationRevisionIds: ['read-v1', 'write-v1'] }],
    });
  });

  it('answers "Not now" as a no, sending no account', async () => {
    const user = userEvent.setup();
    const transport = transportFor();
    renderDialog(transport);

    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'denied',
      })
    );
  });

  it('shows an answered request as the same one-line record the chat keeps', async () => {
    renderDialog(transportFor({ ...REQUEST, status: 'denied' }));
    expect(await screen.findByTestId('agent-request-receipt')).toHaveTextContent(
      'Researcher wasn’t given Gmail'
    );
  });

  it('hands exact actions the agent already holds to the page’s editor', async () => {
    const user = userEvent.setup();
    const transport = transportFor();
    // Only the send action: a set neither level describes.
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-1', operationRevisionIds: ['write-v1'] }])
    );
    const edit = vi.fn();
    renderDialog(transport, edit);

    expect(
      await screen.findByText(/Researcher already has exact actions chosen for this account\./)
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Choose exact actions' }));
    expect(edit).toHaveBeenCalledWith('connection-1');
  });

  it('offers a retry when the request cannot be read', async () => {
    const transport = transportFor();
    vi.mocked(transport.getConnectorAgentRequest).mockRejectedValue(new Error('offline'));
    renderDialog(transport);
    expect(await screen.findByText('Couldn’t load this request')).toBeVisible();
  });
});
