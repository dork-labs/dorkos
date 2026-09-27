/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConnectorAgentRequestItem,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import type {
  ConnectorCatalogService,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentRequestCard } from '../ui/agent-request/AgentRequestCard';
import { ChatAgentRequest } from '../ui/agent-request/ChatAgentRequest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search }: { children: React.ReactNode; to: string; search: object }) => (
    <a href={`${to}?${new URLSearchParams(search as Record<string, string>)}`}>{children}</a>
  ),
}));

afterEach(cleanup);

const REQUEST = {
  requestId: 'request-1',
  reviewUrl: '/connections?request=request-1',
  serviceSlug: 'gmail',
  reason: 'Summarise today’s inbox',
  requestedOperations: ['GMAIL_FETCH_EMAILS'],
  requestedEvents: [],
  createdAt: '2026-09-26T10:00:00.000Z',
  expiresAt: '2099-09-26T12:00:00.000Z',
  status: 'awaiting_owner',
  sessionId: 'session-1',
  agent: { id: 'agent-bo', displayName: 'Bo' },
} as ConnectorAgentRequestItem;

const capabilities = {
  catalog: { status: 'available' as const },
  authentication: { status: 'available' as const },
  accounts: { status: 'available' as const },
  operations: { status: 'available' as const },
  execution: { status: 'available' as const },
  triggers: { status: 'unsupported' as const, reason: 'Not yet.' },
};

const GMAIL: ConnectorCatalogService = {
  serviceSlug: 'gmail',
  displayName: 'Gmail',
  iconKey: 'gmail',
  signInName: 'Google',
  intents: [
    {
      kind: 'account',
      displayName: 'Use a Gmail account',
      routes: [
        {
          providerInstanceId: 'composio-1' as never,
          displayName: 'composio',
          mode: 'byo',
          custody: 'managed',
          payer: 'operator_byo',
          capabilities,
          disclosure: 'Composio stores login access.',
          authKind: 'oauth2',
          signInThrough: 'Composio',
        },
      ],
    },
  ],
};

function account(connectionId: string): ConnectorConnectionSummary {
  return {
    connectionId: connectionId as never,
    providerInstanceId: 'composio-1' as never,
    toolkit: 'gmail',
    label: 'work',
    identityHint: 'bo@example.com',
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'byo',
    custody: 'managed',
    payer: 'operator_byo',
    agentCount: 0,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    warnings: [],
  };
}

function preview(
  grants: ConnectorReconciliationPreview['currentGrants'] = []
): ConnectorReconciliationPreview {
  return {
    previewId: 'preview-1',
    connection: {
      connectionId: 'connection-1' as never,
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [
      {
        operationRevisionId: 'read-v1',
        toolkit: 'gmail',
        operationSlug: 'GMAIL_FETCH_EMAILS',
        toolkitVersion: '1',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchema: {},
        supported: true,
      },
    ],
    agents: [{ agentId: 'agent-bo', displayName: 'Bo' }],
    currentGrants: grants,
    catalogComplete: true,
    createdAt: '2026-09-26T00:00:00.000Z',
    expiresAt: '2099-09-26T01:00:00.000Z',
  };
}

function transportWith(accounts: ConnectorConnectionSummary[]): Transport {
  const transport = createMockTransport();
  vi.mocked(transport.getConnectorConnections).mockResolvedValue({ connections: accounts });
  vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
    services: [GMAIL],
    warnings: [],
  } as never);
  vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
  return transport;
}

function renderWith(transport: Transport, ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('AgentRequestCard — no account yet', () => {
  it('asks to connect the app, names whose sign-in page comes next, and signs in for this request', async () => {
    const user = userEvent.setup();
    const transport = transportWith([]);
    vi.mocked(transport.startConnectorAgentRequestAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'composio-1',
      toolkit: 'gmail',
      state: 'pending',
      authorizeUrl: 'https://accounts.example/consent',
    } as never);
    vi.mocked(transport.pollConnectorAgentRequestAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'composio-1',
      toolkit: 'gmail',
      state: 'pending',
      authorizeUrl: 'https://accounts.example/consent',
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    expect(await screen.findByRole('heading', { name: 'Connect Gmail' })).toBeInTheDocument();
    expect(screen.getByText('Summarise today’s inbox')).toBeInTheDocument();
    expect(await screen.findByText(/Google will ask you to allow Composio/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Connect Gmail' }));
    expect(transport.startConnectorAgentRequestAuthentication).toHaveBeenCalledWith('request-1', {
      providerInstanceId: 'composio-1',
    });
    expect(await screen.findByRole('link', { name: /Sign in to Gmail/ })).toHaveAttribute(
      'href',
      'https://accounts.example/consent'
    );
    expect(screen.getByText(/Waiting for you to finish signing in/)).toBeInTheDocument();
    // Signing in alone answers nothing.
    expect(transport.resolveConnectorAgentRequest).not.toHaveBeenCalled();
  });

  it('shows the one-time setup step inside the card when no way reaches apps', async () => {
    const user = userEvent.setup();
    const transport = transportWith([]);
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
      services: [{ ...GMAIL, intents: [{ ...GMAIL.intents[0], routes: [] }] }],
      warnings: [],
      appConnections: {
        ways: [],
        newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
      },
    } as never);
    vi.mocked(transport.getConnectorProviders).mockResolvedValue([
      {
        type: 'composio',
        configured: false,
        registered: false,
        custody: 'managed',
        disclosure: 'Composio keeps sign-ins.',
      },
    ] as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
    expect(await screen.findByTestId('first-connect-step')).toBeInTheDocument();
    expect(transport.startConnectorAgentRequestAuthentication).not.toHaveBeenCalled();
  });

  it('answers "Not now" as a denial', async () => {
    const user = userEvent.setup();
    const transport = transportWith([]);
    vi.mocked(transport.resolveConnectorAgentRequest).mockResolvedValue({
      ...REQUEST,
      status: 'denied',
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
      decision: 'denied',
    });
  });
});

describe('AgentRequestCard — an account exists', () => {
  it('asks only "Let Bo use Gmail?" and answers the request with the access it just gave', async () => {
    const user = userEvent.setup();
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }],
    });
    vi.mocked(transport.resolveConnectorAgentRequest).mockResolvedValue({
      ...REQUEST,
      status: 'granted',
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    expect(await screen.findByRole('heading', { name: 'Let Bo use Gmail?' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Connect Gmail' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'current_access',
        connectionId: 'connection-1',
      })
    );
    // Only the fixed agent's access was written, and before the answer.
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
      previewId: 'preview-1',
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }],
    });
  });

  it('says plainly when the answer did not save', async () => {
    const user = userEvent.setup();
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }])
    );
    vi.mocked(transport.resolveConnectorAgentRequest).mockRejectedValue(
      Object.assign(new Error('pending'), { code: 'authority_sync_failed' })
    );
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Access is still being set up. Try again in a moment.'
    );
  });
});

describe('AgentRequestCard — answered', () => {
  it.each([
    ['granted', 'Gmail connected · Bo can use it'],
    ['denied', 'Bo wasn’t given Gmail'],
    ['expired', 'This request for Gmail ran out of time. Bo can ask again.'],
    ['authentication_failed', 'Signing in to Gmail didn’t finish. Nothing was shared.'],
    ['access_pending', 'Giving Bo access to Gmail…'],
  ] as const)('reads %s as a one-line record with nothing to press', async (status, line) => {
    const transport = transportWith([]);
    renderWith(
      transport,
      <AgentRequestCard
        request={
          {
            ...REQUEST,
            status,
            connectionId: 'c',
            grantedOperationRevisionIds: [],
            grantedEvents: [],
          } as never
        }
      />
    );
    expect(await screen.findByTestId('agent-request-receipt')).toHaveTextContent(line);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('sends a request that also asks for new-activity updates to the full review', async () => {
    const transport = transportWith([account('connection-1')]);
    renderWith(
      transport,
      <AgentRequestCard request={{ ...REQUEST, requestedEvents: ['GMAIL_NEW_MESSAGE'] }} />
    );
    expect(await screen.findByRole('link', { name: /Review request/ })).toHaveAttribute(
      'href',
      '/connections?request=request-1'
    );
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });
});

describe('ChatAgentRequest', () => {
  const CALL_INPUT = JSON.stringify({
    version: 1,
    serviceSlug: 'gmail',
    reason: 'Summarise today’s inbox',
    requestedOperations: ['GMAIL_FETCH_EMAILS'],
  });

  it('draws the card for the request a held call opened, reading only this conversation', async () => {
    const transport = transportWith([]);
    vi.mocked(transport.getConnectorAgentRequests).mockResolvedValue([REQUEST]);
    renderWith(
      transport,
      <ChatAgentRequest
        sessionId="session-1"
        input={CALL_INPUT}
        result={undefined}
        fallback={<p>plain tool card</p>}
      />
    );
    expect(await screen.findByRole('heading', { name: 'Connect Gmail' })).toBeInTheDocument();
    expect(transport.getConnectorAgentRequests).toHaveBeenCalledWith(undefined, 'session-1');
    expect(screen.queryByText('plain tool card')).not.toBeInTheDocument();
  });

  it('keeps the plain tool card when the reader cannot see a request for the call', async () => {
    const transport = transportWith([]);
    vi.mocked(transport.getConnectorAgentRequests).mockRejectedValue(new Error('forbidden'));
    renderWith(
      transport,
      <ChatAgentRequest
        sessionId="session-1"
        input={CALL_INPUT}
        result={undefined}
        fallback={<p>plain tool card</p>}
      />
    );
    expect(await screen.findByText('plain tool card')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-agent-request')).not.toBeInTheDocument();
  });
});
