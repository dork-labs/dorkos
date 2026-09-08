/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { gmailFilterSchema } from './event-filter-fixtures';
import { AgentRequests } from '../ui/AgentRequests';

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const REQUEST: ConnectorAgentRequestItem = {
  requestId: 'request-1',
  reviewUrl: '/connections?request=request-1',
  serviceSlug: 'gmail',
  reason: 'Summarize new mail and prepare replies.',
  requestedOperations: ['gmail.messages.list', 'gmail.messages.send', 'gmail.messages.delete'],
  requestedEvents: [],
  createdAt: '2026-09-07T12:00:00.000Z',
  expiresAt: '2099-09-07T14:00:00.000Z',
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
  mode: 'managed' as const,
  custody: 'managed' as const,
  payer: 'dorkos_managed' as const,
  agentCount: 0,
  subscriptionCount: 0,
  usage: { status: 'available' as const, logicalOperationCount: 0, attemptCount: 0 },
  warnings: [],
};

function transportFor(request: ConnectorAgentRequestItem = REQUEST): Transport {
  const transport = createMockTransport();
  vi.mocked(transport.getConnectorAgentRequests).mockResolvedValue([request]);
  vi.mocked(transport.getConnectorAgentRequest).mockResolvedValue(request);
  vi.mocked(transport.getConnectorConnections).mockResolvedValue({ connections: [CONNECTION] });
  vi.mocked(transport.getConnectorConnection).mockResolvedValue({
    connection: CONNECTION,
    provider: {
      providerInstanceId: 'provider-1' as never,
      displayName: 'DorkOS managed',
      mode: 'managed',
      custody: 'managed',
      payer: 'dorkos_managed',
      capabilities: {
        catalog: { status: 'available' },
        authentication: { status: 'available' },
        accounts: { status: 'available' },
        operations: { status: 'available' },
        execution: { status: 'available' },
        triggers: { status: 'available' },
      },
      disclosure: 'DorkOS stores login access with its managed provider.',
    },
    agents: [],
    sessions: { affectedCount: 0 },
    subscriptions: {
      totalCount: 0,
      activeCount: 0,
      capability: { status: 'available' },
    },
  });
  vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
    services: [
      {
        serviceSlug: 'gmail',
        displayName: 'Gmail',
        iconKey: 'gmail',
        intents: [
          {
            kind: 'account',
            displayName: 'Use a Gmail account',
            routes: [],
          },
        ],
      },
    ],
    warnings: [],
  });
  vi.mocked(transport.getConnectionEventSource).mockResolvedValue({
    setupMode: 'managed',
    configured: false,
    endpoint: null,
    reason: null,
  });
  vi.mocked(transport.listConnectionEventDefinitions).mockResolvedValue({
    definitions: request.requestedEvents.map((eventType, index) => ({
      id: `definition-${index + 1}`,
      eventType,
      displayName: eventType === 'gmail.message_received' ? 'New email' : 'Mailbox changed',
      toolkit: 'gmail',
      toolkitVersion: '2026-09-01',
      definitionHash: `sha256:${String(index + 1).repeat(64)}`,
      filterSchema: {},
      payloadSchema: {},
      deliveryMode: 'webhook' as const,
      expectedCadenceSeconds: null,
    })),
  });
  vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue({
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
      {
        operationRevisionId: 'read-v1',
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.list',
        toolkitVersion: '1',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchema: {},
        supported: true,
      },
      {
        operationRevisionId: 'write-v1',
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.send',
        toolkitVersion: '1',
        capabilityClassification: 'write',
        retryPolicy: 'never',
        inputSchema: {},
        supported: true,
      },
      {
        operationRevisionId: 'delete-v1',
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.delete',
        toolkitVersion: '1',
        capabilityClassification: 'destructive',
        retryPolicy: 'never',
        inputSchema: {},
        supported: true,
      },
    ],
    agents: [{ agentId: 'agent-1', displayName: 'Researcher' }],
    currentGrants: [],
    catalogComplete: true,
    createdAt: '2026-09-07T12:00:00.000Z',
    expiresAt: '2099-09-07T12:05:00.000Z',
  });
  vi.mocked(transport.resolveConnectorAgentRequest).mockImplementation(async (_id, decision) => ({
    ...request,
    ...(decision.decision === 'approved'
      ? {
          status: 'granted' as const,
          connectionId: decision.connectionId,
          grantedOperationRevisionIds: decision.operationRevisionIds,
          grantedEvents: [],
        }
      : { status: 'denied' as const }),
  }));
  return transport;
}

function renderRequests(transport: Transport, selectedRequestId: string | null = 'request-1') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <AgentRequests selectedRequestId={selectedRequestId} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return {
    ...view,
    rerenderSelected(nextRequestId: string | null) {
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <AgentRequests selectedRequestId={nextRequestId} />
          </TransportProvider>
        </QueryClientProvider>
      );
    },
  };
}

describe('AgentRequests', () => {
  it('shows the private-safe request list and exact owner reason', async () => {
    renderRequests(transportFor(), null);

    expect(await screen.findByText('Researcher · Gmail')).toBeInTheDocument();
    expect(screen.getByText('Summarize new mail and prepare replies.')).toBeInTheDocument();
    expect(screen.queryByText('Work mail')).not.toBeInTheDocument();
  });

  it('defaults to requested read/write revisions and requires a separate destructive choice', async () => {
    const user = userEvent.setup();
    const transport = transportFor();
    renderRequests(transport);

    expect(await screen.findByRole('heading', { name: 'Review agent access' })).toBeVisible();
    expect(await screen.findByTestId('agent-request-custody')).toHaveTextContent(
      'DorkOS stores login access'
    );
    expect(await screen.findByRole('checkbox', { name: 'List' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Send' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Delete' })).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Grant access' }));
    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'approved',
        connectionId: 'connection-1',
        operationRevisionIds: ['read-v1', 'write-v1'],
        eventScopes: [],
      })
    );
    expect(await screen.findByTestId('agent-request-outcome')).toHaveTextContent('Granted');
  });

  it('sends one exact event scope with the single owner decision and no pre-grant subscription', async () => {
    const user = userEvent.setup();
    const transport = transportFor({
      ...REQUEST,
      requestedEvents: ['gmail.message_received'],
    });
    vi.mocked(transport.listConnectionEventDefinitions).mockResolvedValue({
      definitions: [
        {
          id: 'definition-1',
          eventType: 'gmail.message_received',
          displayName: 'New email',
          toolkit: 'gmail',
          toolkitVersion: '2026-09-01',
          definitionHash: `sha256:${'1'.repeat(64)}`,
          filterSchema: {
            type: 'object',
            properties: { folder: { type: 'string', title: 'Folder' } },
            required: ['folder'],
          },
          payloadSchema: {},
          deliveryMode: 'webhook',
          expectedCadenceSeconds: null,
        },
      ],
    });
    renderRequests(transport);

    expect(await screen.findByText('Notifications')).toBeVisible();
    const grant = screen.getByRole('button', { name: 'Grant access' });
    expect(grant).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(grant).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), 'inbox');
    expect(grant).toBeEnabled();
    await user.click(grant);

    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'approved',
        connectionId: 'connection-1',
        operationRevisionIds: ['read-v1', 'write-v1'],
        eventScopes: [
          {
            connectionId: 'connection-1',
            definitionId: 'definition-1',
            filter: { folder: 'inbox' },
            agentId: 'agent-1',
            destination: { kind: 'agent', id: 'agent-1' },
          },
        ],
      })
    );
    expect(transport.createConnectionEventSubscription).not.toHaveBeenCalled();
  });

  it('includes defaults and an explicit blank in the exact owner-approved event scope', async () => {
    const user = userEvent.setup();
    const transport = transportFor({ ...REQUEST, requestedEvents: ['gmail.message_received'] });
    vi.mocked(transport.listConnectionEventDefinitions).mockResolvedValue({
      definitions: [
        {
          id: 'definition-defaults',
          eventType: 'gmail.message_received',
          displayName: 'New email',
          toolkit: 'gmail',
          toolkitVersion: '2026-09-01',
          definitionHash: `sha256:${'1'.repeat(64)}`,
          filterSchema: gmailFilterSchema,
          payloadSchema: {},
          deliveryMode: 'polling',
          expectedCadenceSeconds: null,
        },
      ],
    });
    renderRequests(transport);
    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(screen.getByRole('textbox', { name: 'Labels' })).toHaveValue('INBOX');
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('');
    expect(screen.getByRole('spinbutton', { name: 'Interval' })).toHaveValue(1.5);
    await user.clear(screen.getByRole('textbox', { name: 'Labels' }));
    await user.type(screen.getByRole('textbox', { name: 'Labels' }), 'owner-label');
    const grant = screen.getByRole('button', { name: 'Grant access' });
    await waitFor(() => expect(grant).toBeEnabled());
    await user.click(grant);
    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'approved',
        connectionId: 'connection-1',
        operationRevisionIds: ['read-v1', 'write-v1'],
        eventScopes: [
          {
            connectionId: 'connection-1',
            definitionId: 'definition-defaults',
            filter: { interval: 1.5, labelIds: 'owner-label', query: '', userId: 'me' },
            agentId: 'agent-1',
            destination: { kind: 'agent', id: 'agent-1' },
          },
        ],
      })
    );
    expect(transport.createConnectionEventSubscription).not.toHaveBeenCalled();
  });

  it('requires one complete exact scope for every requested event', async () => {
    const user = userEvent.setup();
    const transport = transportFor({
      ...REQUEST,
      requestedEvents: ['gmail.message_received', 'gmail.mailbox_changed'],
    });
    renderRequests(transport);

    const grant = await screen.findByRole('button', { name: 'Grant access' });
    const activity = await screen.findAllByRole('combobox', { name: 'Account activity' });
    await user.click(activity[0]!);
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(grant).toBeDisabled();
    await user.click(activity[1]!);
    await user.click(await screen.findByRole('option', { name: 'Mailbox changed' }));
    expect(grant).toBeEnabled();
  });

  it('refuses an event definition whose filter cannot be represented safely', async () => {
    const user = userEvent.setup();
    const request = { ...REQUEST, requestedEvents: ['gmail.message_received'] };
    const transport = transportFor(request);
    vi.mocked(transport.listConnectionEventDefinitions).mockResolvedValue({
      definitions: [
        {
          id: 'definition-unsupported',
          eventType: 'gmail.message_received',
          displayName: 'New email',
          toolkit: 'gmail',
          toolkitVersion: '2026-09-01',
          definitionHash: `sha256:${'a'.repeat(64)}`,
          filterSchema: {
            type: 'object',
            properties: {},
            patternProperties: { '.*': { type: 'string' } },
          },
          payloadSchema: {},
          deliveryMode: 'webhook',
          expectedCadenceSeconds: null,
        },
      ],
    });
    renderRequests(transport);

    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(
      screen.getByText('This notification needs filter controls this app cannot safely show yet.')
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeDisabled();
    expect(transport.resolveConnectorAgentRequest).not.toHaveBeenCalled();
  });

  it('uses server source authority and never offers definitions for unrequested activity', async () => {
    const user = userEvent.setup();
    const request = { ...REQUEST, requestedEvents: ['gmail.message_received'] };
    const transport = transportFor(request);
    vi.mocked(transport.getConnectionEventSource).mockResolvedValue({
      setupMode: 'unavailable',
      configured: false,
      endpoint: null,
      reason: 'Notifications are unavailable for this account.',
    });
    vi.mocked(transport.listConnectionEventDefinitions).mockResolvedValue({
      definitions: [
        {
          id: 'definition-requested',
          eventType: 'gmail.message_received',
          displayName: 'New email',
          toolkit: 'gmail',
          toolkitVersion: '2026-09-01',
          definitionHash: `sha256:${'c'.repeat(64)}`,
          filterSchema: {},
          payloadSchema: {},
          deliveryMode: 'webhook',
          expectedCadenceSeconds: null,
        },
        {
          id: 'definition-unrequested',
          eventType: 'gmail.draft_created',
          displayName: 'Draft created',
          toolkit: 'gmail',
          toolkitVersion: '2026-09-01',
          definitionHash: `sha256:${'d'.repeat(64)}`,
          filterSchema: {},
          payloadSchema: {},
          deliveryMode: 'webhook',
          expectedCadenceSeconds: null,
        },
      ],
    });
    renderRequests(transport);

    expect(
      await screen.findByText('Notifications are unavailable for this account.')
    ).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Account activity' }));
    expect(await screen.findByRole('option', { name: 'New email' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Draft created' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'New email' }));
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeDisabled();
  });

  it('loads later definition pages before deciding requested activity is unavailable', async () => {
    const user = userEvent.setup();
    const request = { ...REQUEST, requestedEvents: ['gmail.message_received'] };
    const transport = transportFor(request);
    vi.mocked(transport.listConnectionEventDefinitions)
      .mockResolvedValueOnce({ definitions: [], nextCursor: 'definitions-2' })
      .mockResolvedValueOnce({
        definitions: [
          {
            id: 'definition-later',
            eventType: 'gmail.message_received',
            displayName: 'New email',
            toolkit: 'gmail',
            toolkitVersion: '2026-09-01',
            definitionHash: `sha256:${'b'.repeat(64)}`,
            filterSchema: {},
            payloadSchema: {},
            deliveryMode: 'unknown',
            expectedCadenceSeconds: null,
          },
        ],
      });
    renderRequests(transport);

    expect(
      await screen.findByText('Load more notification options to finish this request.')
    ).toBeVisible();
    expect(screen.queryByText('This account does not currently offer this activity.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load more notification options' }));
    expect(await screen.findByRole('combobox', { name: 'Account activity' })).toBeVisible();
    expect(transport.listConnectionEventDefinitions).toHaveBeenNthCalledWith(
      2,
      'connection-1',
      'definitions-2'
    );
  });

  it('discards completed event scopes when the owner changes accounts', async () => {
    const user = userEvent.setup();
    const request = { ...REQUEST, requestedEvents: ['gmail.message_received'] };
    const transport = transportFor(request);
    const secondConnection = {
      ...CONNECTION,
      connectionId: 'connection-2' as never,
      label: 'Personal mail',
      identityHint: 'p•••@example.com',
    };
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({
      connections: [CONNECTION, secondConnection],
    });
    vi.mocked(transport.getConnectorConnection).mockImplementation(async (connectionId) => ({
      connection: connectionId === 'connection-2' ? secondConnection : CONNECTION,
      provider: {
        providerInstanceId: 'provider-1' as never,
        displayName: 'DorkOS managed',
        mode: 'managed',
        custody: 'managed',
        payer: 'dorkos_managed',
        capabilities: {
          catalog: { status: 'available' },
          authentication: { status: 'available' },
          accounts: { status: 'available' },
          operations: { status: 'available' },
          execution: { status: 'available' },
          triggers: { status: 'available' },
        },
        disclosure: 'DorkOS stores login access with its managed provider.',
      },
      agents: [],
      sessions: { affectedCount: 0 },
      subscriptions: {
        totalCount: 0,
        activeCount: 0,
        capability: { status: 'available' },
      },
    }));
    renderRequests(transport);

    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeEnabled();

    await user.click(screen.getByRole('combobox', { name: 'Account' }));
    await user.click(await screen.findByRole('option', { name: /Personal mail/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Grant access' })).toBeDisabled()
    );
    expect(transport.resolveConnectorAgentRequest).not.toHaveBeenCalled();
  });

  it('discards completed event scopes when the selected request changes', async () => {
    const user = userEvent.setup();
    const firstRequest = { ...REQUEST, requestedEvents: ['gmail.message_received'] };
    const secondRequest = {
      ...firstRequest,
      requestId: 'request-2',
      reviewUrl: '/connections?request=request-2',
      reason: 'Notify me about a different task.',
    };
    const transport = transportFor(firstRequest);
    vi.mocked(transport.getConnectorAgentRequest).mockImplementation(async (requestId) =>
      requestId === 'request-2' ? secondRequest : firstRequest
    );
    const view = renderRequests(transport);

    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeEnabled();

    view.rerenderSelected('request-2');
    expect(await screen.findByText('Notify me about a different task.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeDisabled();
    expect(transport.resolveConnectorAgentRequest).not.toHaveBeenCalled();
  });

  it('denies without sending an account or service action selection', async () => {
    const user = userEvent.setup();
    const transport = transportFor();
    renderRequests(transport);

    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'denied',
      })
    );
  });
});
