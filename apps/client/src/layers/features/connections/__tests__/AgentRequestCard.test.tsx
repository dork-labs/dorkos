/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CONNECTION_READINESS_COPY,
  type ConnectionFixAction,
  type ConnectionReadinessReason,
  type ConnectionReadinessState,
  type ConnectorAgentRequestItem,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import type {
  ConnectorCatalogService,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport, createMockConnectionReadiness } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentRequestCard } from '../ui/agent-request/AgentRequestCard';
import { ChatAgentRequest } from '../ui/agent-request/ChatAgentRequest';

const openSettings = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search }: { children: React.ReactNode; to: string; search: object }) => (
    <a href={`${to}?${new URLSearchParams(search as Record<string, string>)}`}>{children}</a>
  ),
}));

// Radix Select reads pointer capture, which jsdom does not implement.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

/** The chat's own view with Gmail turned off; `canTurnOn` is whether readiness offers turning it on. */
function chatTurnedOff(canTurnOn: boolean) {
  return {
    sessionId: 'session-1',
    agentId: 'agent-bo',
    connections: [
      {
        connectionId: 'connection-1' as never,
        toolkit: 'gmail',
        label: 'work',
        source: 'this_chat' as const,
        operationRevisionIds: [],
        readiness: createMockConnectionReadiness({
          state: 'unavailable',
          reason: 'off_for_this_chat',
          ...(canTurnOn && {
            fix: { action: 'turn_on_for_this_chat' as const, fixableBy: 'person' as const },
          }),
        }),
        ...(canTurnOn && { thisChat: 'off' as const }),
      },
    ],
  };
}

const REQUEST = {
  requestId: 'request-1',
  serviceSlug: 'gmail',
  reason: 'Summarise today’s inbox',
  access: 'read',
  requestedEvents: [],
  note: 'The person hasn’t answered yet.',
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
    readiness: createMockConnectionReadiness(),
    everyAgent: null,
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
      ['read-v1', 'GMAIL_FETCH_EMAILS', 'read'],
      ['send-v1', 'GMAIL_SEND_EMAIL', 'write'],
      ['delete-v1', 'GMAIL_DELETE_EMAIL', 'destructive'],
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
    agents: [{ agentId: 'agent-bo', displayName: 'Bo' }],
    currentGrants: grants,
    catalogComplete: true,
    everyAgent: { available: true, operationRevisionIds: [] },
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
    vi.mocked(transport.getConnectorProviders).mockResolvedValue({
      providers: [
        {
          type: 'composio',
          providerInstanceId: 'composio-1',
          configured: false,
          registered: false,
          custody: 'managed',
          disclosure: 'Composio keeps sign-ins.',
        },
      ],
      appConnections: { ways: [], newApps: { status: 'setup_needed', reason: 'nothing_set_up' } },
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
    const step = await screen.findByTestId('first-connect-step');
    // Composio isn't set up, so its key is the choice the step offers.
    expect(within(step).getByRole('button', { name: /Use my Composio key/ })).toBeInTheDocument();
    expect(transport.startConnectorAgentRequestAuthentication).not.toHaveBeenCalled();
  });

  it('says the DorkOS account isn’t linked anymore in the one-time step, beside a key as an equal choice', async () => {
    const user = userEvent.setup();
    openSettings.mockClear();
    const transport = transportWith([]);
    const appConnections = {
      ways: [{ kind: 'dorkos_account', type: 'dorkos-managed', status: 'unlinked' }],
      newApps: { status: 'setup_needed', reason: 'dorkos_account_unlinked' },
    };
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
      services: [{ ...GMAIL, intents: [{ ...GMAIL.intents[0], routes: [] }] }],
      warnings: [],
      appConnections,
    } as never);
    vi.mocked(transport.getConnectorProviders).mockResolvedValue({
      providers: [
        {
          type: 'composio',
          providerInstanceId: 'composio-1',
          configured: false,
          registered: false,
          custody: 'managed',
          disclosure: 'Composio keeps sign-ins.',
        },
      ],
      appConnections,
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
    const step = await screen.findByTestId('first-connect-step');
    expect(step).toHaveTextContent('Your DorkOS account isn’t linked anymore.');
    expect(step).not.toHaveTextContent(/come back|bring/);
    const relink = await screen.findByRole('button', { name: 'Link my DorkOS account again' });
    const key = screen.getByRole('button', { name: /Use my Composio key/ });
    // Equal choices: the same weight, neither pressed on the person.
    expect(relink.className).toBe(key.className);
    await user.click(relink);
    expect(openSettings).toHaveBeenCalledWith('account');
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
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }],
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
        eventScopes: [],
      })
    );
    // Only the fixed agent's access was written, and before the answer.
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
      previewId: 'preview-1',
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }],
    });
  });

  it('never says "nothing changed" once the access landed, and Try again re-sends the answer', async () => {
    const user = userEvent.setup();
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }])
    );
    vi.mocked(transport.resolveConnectorAgentRequest)
      .mockRejectedValueOnce(new Error('network dropped'))
      .mockResolvedValueOnce({ ...REQUEST, status: 'granted' } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    const unanswered = await screen.findByTestId('agent-request-unanswered');
    expect(unanswered).toHaveTextContent('The access is saved, but Bo’s request wasn’t answered');
    expect(unanswered).not.toHaveTextContent(/nothing changed/i);
    expect(screen.getByRole('heading', { name: 'Bo can now use Gmail' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledTimes(2));
    expect(transport.resolveConnectorAgentRequest).toHaveBeenLastCalledWith('request-1', {
      decision: 'current_access',
      connectionId: 'connection-1',
      eventScopes: [],
    });
  });

  it('offers to turn the app on for this chat when the chat has it off, then answers the request', async () => {
    const user = userEvent.setup();
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }])
    );
    vi.mocked(transport.resolveConnectorAgentRequest)
      .mockRejectedValueOnce(Object.assign(new Error('off'), { code: 'session_access_off' }))
      .mockResolvedValueOnce({ ...REQUEST, status: 'approved' } as never);
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue(chatTurnedOff(true));
    vi.mocked(transport.setSessionConnectorAccess).mockResolvedValue({
      sessionId: REQUEST.sessionId,
      agentId: 'agent-bo',
      connections: [],
    });
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    const unanswered = await screen.findByTestId('agent-request-unanswered');
    expect(unanswered).toHaveTextContent('this chat has Gmail turned off for Bo');
    expect(await screen.findByText(/only affects this chat/)).toBeInTheDocument();
    expect(transport.getSessionConnectorConnections).toHaveBeenCalledWith(REQUEST.sessionId);
    expect(unanswered).not.toHaveTextContent(/can’t be changed/);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Turn on for this chat' }));
    await waitFor(() =>
      expect(transport.setSessionConnectorAccess).toHaveBeenCalledWith(
        REQUEST.sessionId,
        'connection-1',
        { on: true }
      )
    );
    await waitFor(() => expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledTimes(2));
    expect(transport.resolveConnectorAgentRequest).toHaveBeenLastCalledWith('request-1', {
      decision: 'current_access',
      connectionId: 'connection-1',
      eventScopes: [],
    });
  });

  it('offers no turn-on button when the chat’s readiness does not name it as the fix', async () => {
    const user = userEvent.setup();
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }])
    );
    vi.mocked(transport.resolveConnectorAgentRequest).mockRejectedValue(
      Object.assign(new Error('off'), { code: 'session_access_off' })
    );
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue(chatTurnedOff(false));
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    const unanswered = await screen.findByTestId('agent-request-unanswered');
    expect(unanswered).toHaveTextContent('this chat has Gmail turned off for Bo');
    await waitFor(() =>
      expect(transport.getSessionConnectorConnections).toHaveBeenCalledWith(REQUEST.sessionId)
    );
    expect(screen.queryByRole('button', { name: 'Turn on for this chat' })).not.toBeInTheDocument();
    expect(unanswered).not.toHaveTextContent(/only affects this chat/);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('says so, and does not answer, when turning the app on for this chat fails', async () => {
    const user = userEvent.setup();
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }])
    );
    vi.mocked(transport.resolveConnectorAgentRequest).mockRejectedValue(
      Object.assign(new Error('off'), { code: 'session_access_off' })
    );
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue(chatTurnedOff(true));
    vi.mocked(transport.setSessionConnectorAccess).mockRejectedValue(new Error('offline'));
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await user.click(await screen.findByRole('button', { name: 'Turn on for this chat' }));

    expect(await screen.findByText(/Couldn’t turn it on for this chat/)).toBeInTheDocument();
    expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['request_already_resolved', 'already answered somewhere else'],
    ['request_expired', 'ran out of time'],
  ])('offers no retry that cannot land when the request is %s', async (code, words) => {
    const user = userEvent.setup();
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }])
    );
    vi.mocked(transport.resolveConnectorAgentRequest).mockRejectedValue(
      Object.assign(new Error('refused'), { code })
    );
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(await screen.findByTestId('agent-request-unanswered')).toHaveTextContent(words);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('starts on the level the agent asked for and says what it asked for', async () => {
    const transport = transportWith([account('connection-1')]);
    renderWith(transport, <AgentRequestCard request={{ ...REQUEST, access: 'read-write' }} />);
    const asked = await screen.findByTestId('requested-access');
    expect(asked).toHaveTextContent('Bo asked: Summarise today’s inbox');
    expect(asked).toHaveTextContent('It wants to read and change things in Gmail.');
    expect(screen.getByRole('radio', { name: 'Read and write' })).toBeChecked();
    expect(asked).not.toHaveTextContent('With Read');
  });

  it('says what Read leaves out when the person picks it over the level asked for', async () => {
    const user = userEvent.setup();
    const transport = transportWith([account('connection-1')]);
    renderWith(transport, <AgentRequestCard request={{ ...REQUEST, access: 'read-write' }} />);
    const asked = await screen.findByTestId('requested-access');
    await user.click(screen.getByRole('radio', { name: 'Read' }));
    expect(asked).toHaveTextContent('With Read, Bo can’t change anything in Gmail.');
  });

  it('starts on Read when that is all the agent asked for', async () => {
    const transport = transportWith([account('connection-1')]);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);
    expect(await screen.findByTestId('requested-access')).toHaveTextContent(
      'It wants to read Gmail.'
    );
    expect(screen.getByRole('radio', { name: 'Read' })).toBeChecked();
  });
});

describe('AgentRequestCard — answered', () => {
  it.each([
    ['granted', 'Allowed Bo to use Gmail'],
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
});

describe('AgentRequestCard — a request that also asks for updates', () => {
  const EVENT_REQUEST = { ...REQUEST, requestedEvents: ['gmail.message_received'] };

  function updatesTransport(): Transport {
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }],
    });
    vi.mocked(transport.getConnectionEventSource).mockResolvedValue({
      setupMode: 'managed',
      configured: false,
      endpoint: null,
      reason: null,
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
          filterSchema: {},
          payloadSchema: {},
          deliveryMode: 'webhook',
          expectedCadenceSeconds: null,
        },
      ],
    });
    return transport;
  }

  it('answers in the card: access first, then the exact updates, in one answer', async () => {
    const user = userEvent.setup();
    const transport = updatesTransport();
    renderWith(transport, <AgentRequestCard request={EVENT_REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(
      await screen.findByRole('heading', { name: 'Send Bo updates from Gmail?' })
    ).toBeInTheDocument();
    // The access is saved; the request waits for the updates choice.
    expect(transport.resolveConnectorAgentRequest).not.toHaveBeenCalled();
    const send = screen.getByRole('button', { name: 'Send updates' });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'current_access',
        connectionId: 'connection-1',
        eventScopes: [
          {
            connectionId: 'connection-1',
            definitionId: 'definition-1',
            filter: {},
            agentId: 'agent-bo',
            destination: { kind: 'agent', id: 'agent-bo' },
          },
        ],
      })
    );
    expect(screen.queryByRole('link', { name: /Review request/ })).not.toBeInTheDocument();
  });

  it('never resends updates that failed, and offers the two answers that can work', async () => {
    const user = userEvent.setup();
    const transport = updatesTransport();
    vi.mocked(transport.resolveConnectorAgentRequest).mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { code: 'event_selection_unavailable' })
    );
    renderWith(transport, <AgentRequestCard request={EVENT_REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    const send = screen.getByRole('button', { name: 'Send updates' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    expect(await screen.findByTestId('agent-request-unanswered')).toHaveTextContent(
      'the updates you picked can’t be set up right now'
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pick updates again' }));
    expect(
      await screen.findByRole('heading', { name: 'Send Bo updates from Gmail?' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'No updates' }));
    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenLastCalledWith('request-1', {
        decision: 'current_access',
        connectionId: 'connection-1',
        eventScopes: [],
      })
    );
  });

  it('reads a changed update choice as "pick again", never as a lost connection', async () => {
    const user = userEvent.setup();
    const transport = updatesTransport();
    vi.mocked(transport.resolveConnectorAgentRequest).mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'review_conflict' })
    );
    renderWith(transport, <AgentRequestCard request={EVENT_REQUEST} />);
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    const send = screen.getByRole('button', { name: 'Send updates' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    const unanswered = await screen.findByTestId('agent-request-unanswered');
    expect(unanswered).not.toHaveTextContent('didn’t reach the server');
    expect(screen.getByRole('button', { name: 'Pick updates again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('answers without updates straight from the failure', async () => {
    const user = userEvent.setup();
    const transport = updatesTransport();
    vi.mocked(transport.resolveConnectorAgentRequest).mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { code: 'event_selection_unavailable' })
    );
    renderWith(transport, <AgentRequestCard request={EVENT_REQUEST} />);
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    const send = screen.getByRole('button', { name: 'Send updates' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await user.click(await screen.findByRole('button', { name: 'Answer without updates' }));
    await waitFor(() => expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledTimes(2));
    expect(transport.resolveConnectorAgentRequest).toHaveBeenLastCalledWith('request-1', {
      decision: 'current_access',
      connectionId: 'connection-1',
      eventScopes: [],
    });
  });

  /** Allow, pick "New email", send: the answer carries exactly this update. */
  async function answerWithUpdates(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    const send = screen.getByRole('button', { name: 'Send updates' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
  }

  const PICKED_UPDATES = {
    decision: 'current_access',
    connectionId: 'connection-1',
    eventScopes: [
      {
        connectionId: 'connection-1',
        definitionId: 'definition-1',
        filter: {},
        agentId: 'agent-bo',
        destination: { kind: 'agent', id: 'agent-bo' },
      },
    ],
  };

  it('resends the same updates after turning the app on for this chat', async () => {
    const user = userEvent.setup();
    const transport = updatesTransport();
    vi.mocked(transport.resolveConnectorAgentRequest)
      .mockRejectedValueOnce(Object.assign(new Error('off'), { code: 'session_access_off' }))
      .mockResolvedValueOnce({ ...EVENT_REQUEST, status: 'granted' } as never);
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue(chatTurnedOff(true));
    vi.mocked(transport.setSessionConnectorAccess).mockResolvedValue({
      sessionId: EVENT_REQUEST.sessionId,
      agentId: 'agent-bo',
      connections: [],
    });
    renderWith(transport, <AgentRequestCard request={EVENT_REQUEST} />);

    await answerWithUpdates(user);
    await user.click(await screen.findByRole('button', { name: 'Turn on for this chat' }));

    await waitFor(() => expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledTimes(2));
    expect(transport.resolveConnectorAgentRequest).toHaveBeenNthCalledWith(
      1,
      'request-1',
      PICKED_UPDATES
    );
    expect(transport.resolveConnectorAgentRequest).toHaveBeenNthCalledWith(
      2,
      'request-1',
      PICKED_UPDATES
    );
  });

  it('resends the same updates on Try again', async () => {
    const user = userEvent.setup();
    const transport = updatesTransport();
    vi.mocked(transport.resolveConnectorAgentRequest)
      .mockRejectedValueOnce(new Error('network dropped'))
      .mockResolvedValueOnce({ ...EVENT_REQUEST, status: 'granted' } as never);
    renderWith(transport, <AgentRequestCard request={EVENT_REQUEST} />);

    await answerWithUpdates(user);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledTimes(2));
    expect(transport.resolveConnectorAgentRequest).toHaveBeenNthCalledWith(
      2,
      'request-1',
      PICKED_UPDATES
    );
  });

  it('can leave updates out and still answer the access', async () => {
    const user = userEvent.setup();
    const transport = updatesTransport();
    renderWith(transport, <AgentRequestCard request={EVENT_REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await user.click(await screen.findByRole('button', { name: 'No updates' }));
    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'current_access',
        connectionId: 'connection-1',
        eventScopes: [],
      })
    );
  });
});

describe('ChatAgentRequest', () => {
  const CALL_INPUT = JSON.stringify({
    version: 1,
    serviceSlug: 'gmail',
    reason: 'Summarise today’s inbox',
    access: 'read',
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

/** The server's readiness for an account that needs one fix first. */
function needs(
  reason: ConnectionReadinessReason,
  action: ConnectionFixAction | undefined,
  owner: string,
  state: ConnectionReadinessState = 'needs_you'
) {
  return createMockConnectionReadiness({
    state,
    reason,
    ...(action && {
      fix: {
        action,
        fixableBy:
          action === 'retry' || action === 'wait' ? ('dorkos' as const) : ('person' as const),
      },
    }),
    copy: { owner, agent: 'Ask the person.' },
  });
}

describe('AgentRequestCard — an account that needs attention first', () => {
  it('says the account’s DorkOS account isn’t linked anymore, and offers to connect the app again', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      {
        ...account('connection-1'),
        mode: 'managed',
        readiness: needs(
          'dorkos_account_unlinked',
          'connect_new',
          CONNECTION_READINESS_COPY.dorkos_account_unlinked.owner
        ),
      },
    ]);
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
      services: [{ ...GMAIL, intents: [{ ...GMAIL.intents[0], routes: [] }] }],
      warnings: [],
      appConnections: {
        ways: [{ kind: 'dorkos_account', type: 'dorkos-managed', status: 'unlinked' }],
        newApps: { status: 'setup_needed', reason: 'dorkos_account_unlinked' },
      },
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    const line = await screen.findByTestId('account-attention');
    expect(line).toHaveAttribute('data-reason', 'dorkos_account_unlinked');
    expect(line).toHaveTextContent(
      'It was connected through your DorkOS account, which isn’t linked anymore'
    );
    // Linking this computer again with the same account can continue its earlier
    // link (DOR-2521): the line says so conditionally, with Connect again beside it.
    expect(line).toHaveTextContent(
      'Linking this computer again with the same DorkOS account can bring it back, unless its earlier link was removed from that account. Otherwise, connect it again.'
    );
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();

    // Connect again goes to the connect step, whose one-time step offers every way.
    await user.click(screen.getByRole('button', { name: 'Connect Gmail again' }));
    await user.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
    expect(await screen.findByTestId('first-connect-step')).toBeInTheDocument();
  });

  it('names a key that isn’t set up or didn’t answer, with its one fix', async () => {
    const user = userEvent.setup();
    openSettings.mockClear();
    const transport = transportWith([
      {
        ...account('connection-1'),
        readiness: needs(
          'own_key_unavailable',
          'fix_key',
          'The key it was connected through isn’t set up or didn’t answer. Fix the key to use it.'
        ),
      },
    ]);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    expect(await screen.findByTestId('account-attention')).toHaveTextContent(
      'isn’t set up or didn’t answer'
    );
    // One problem, one button: connecting again is not a second fix here.
    expect(screen.queryByRole('button', { name: 'Connect Gmail again' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fix the key' }));
    expect(openSettings).toHaveBeenCalledWith('connections', 'ways');
  });

  it('offers a fresh check when the linked DorkOS account can’t reach the app right now', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      {
        ...account('connection-1'),
        readiness: needs(
          'dorkos_account_unavailable',
          'retry',
          CONNECTION_READINESS_COPY.dorkos_account_unavailable.owner,
          'unavailable'
        ),
      },
    ]);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    expect(await screen.findByTestId('account-attention')).toHaveTextContent(
      'can’t reach it right now'
    );
    const reads = vi.mocked(transport.getConnectorConnections).mock.calls.length;
    const catalogReads = vi.mocked(transport.getConnectorCatalog).mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    // The catalog read is what makes the server try the DorkOS account again.
    await waitFor(() =>
      expect(vi.mocked(transport.getConnectorCatalog).mock.calls.length).toBeGreaterThan(
        catalogReads
      )
    );
    await waitFor(() =>
      expect(vi.mocked(transport.getConnectorConnections).mock.calls.length).toBeGreaterThan(reads)
    );
  });

  it('asks to resume a paused account before any Allow', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      {
        ...account('connection-1'),
        lifecycle: 'paused',
        readiness: needs(
          'paused',
          'resume',
          'Paused. Agents can’t use it until you resume it.',
          'paused'
        ),
      },
    ]);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    expect(await screen.findByTestId('account-attention')).toHaveAttribute('data-reason', 'paused');
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(transport.resumeConnectorConnection).toHaveBeenCalledWith('connection-1');
  });

  it('asks to sign in again when the account is signed out', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      {
        ...account('connection-1'),
        authenticationStatus: 'expired',
        readiness: needs('signed_out', 'sign_in_again', 'Signed out.'),
      },
    ]);
    vi.mocked(transport.reconnectConnectorConnection).mockResolvedValue({
      flowId: 'flow-r',
      providerInstanceId: 'composio-1',
      toolkit: 'gmail',
      state: 'pending',
      authorizeUrl: 'https://accounts.example/again',
    } as never);
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue({
      flowId: 'flow-r',
      providerInstanceId: 'composio-1',
      toolkit: 'gmail',
      state: 'pending',
      authorizeUrl: 'https://accounts.example/again',
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    expect(transport.reconnectConnectorConnection).toHaveBeenCalledWith(
      'connection-1',
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    );
    expect(await screen.findByRole('link', { name: /Sign in to Gmail/ })).toHaveAttribute(
      'href',
      'https://accounts.example/again'
    );
  });

  it('says a sign-in that failed and offers it again, instead of turning a spinner forever', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      {
        ...account('connection-1'),
        authenticationStatus: 'expired',
        readiness: needs('signed_out', 'sign_in_again', 'Signed out.'),
      },
    ]);
    vi.mocked(transport.reconnectConnectorConnection).mockResolvedValue({
      flowId: 'flow-f',
      providerInstanceId: 'composio-1',
      toolkit: 'gmail',
      state: 'starting',
    } as never);
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue({
      flowId: 'flow-f',
      providerInstanceId: 'composio-1',
      toolkit: 'gmail',
      state: 'failed',
      reason: 'Sign-in didn’t finish. Try again.',
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That didn’t work.');
    expect(screen.queryByText('Getting the sign-in page ready…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeEnabled();
  });

  it('offers only "Not now" when nothing can be done from here', async () => {
    const transport = transportWith([
      {
        ...account('connection-1'),
        readiness: needs(
          'cannot_run_actions',
          undefined,
          'Agents can’t use apps connected this way yet.',
          'unavailable'
        ),
      },
    ]);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);
    expect(await screen.findByTestId('account-attention')).toHaveTextContent(
      'Agents can’t use apps connected this way yet.'
    );
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Not now']);
  });

  it('skips a paused account when another one is ready', async () => {
    const transport = transportWith([
      {
        ...account('connection-2'),
        label: 'home',
        lifecycle: 'paused',
        readiness: needs('paused', 'resume', 'Paused.', 'paused'),
      },
      account('connection-1'),
    ]);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);
    expect(await screen.findByRole('heading', { name: 'Let Bo use Gmail?' })).toBeInTheDocument();
    // Only one usable account, so no "which account?" question.
    expect(screen.queryByRole('heading', { name: 'Which Gmail account?' })).not.toBeInTheDocument();
  });
});

describe('AgentRequestCard — a managed save that applies later (round 2)', () => {
  it('keeps the question on screen through a pending save and answers once, after sync, with one Allow', async () => {
    const user = userEvent.setup();
    const ready = { ...account('connection-1'), mode: 'managed' as const };
    // After the save, the summary reads pending for the whole account: another
    // agent's change, or this one still applying. Neither may swap the card out.
    const pending = {
      ...ready,
      authoritySync: { status: 'pending' as const },
      readiness: needs('access_updating', 'wait', 'Updating who can use it…', 'finishing'),
    };
    const transport = transportWith([ready]);
    vi.mocked(transport.getConnectorConnections)
      .mockResolvedValueOnce({ connections: [ready] })
      .mockResolvedValue({ connections: [pending] });
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'pending' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }],
    });
    vi.mocked(transport.getConnectorConnection).mockResolvedValue({
      connection: {
        readiness: { state: 'ready', reason: 'usable' },
        connectionId: 'connection-1',
        reconciliationStatus: 'ready',
        authoritySync: { status: 'ready' },
      },
      agents: [
        {
          agentId: 'agent-bo',
          operationRevisionIds: ['read-v1'],
          reconciliationStatus: 'ready',
          authoritySync: { status: 'ready' },
        },
      ],
    } as never);
    vi.mocked(transport.resolveConnectorAgentRequest).mockResolvedValue({
      ...REQUEST,
      status: 'granted',
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(await screen.findByText('Access update pending')).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(transport.getConnectorConnections).mock.calls.length).toBeGreaterThanOrEqual(
        2
      )
    );
    expect(screen.queryByTestId('account-attention')).not.toBeInTheDocument();
    expect(transport.resolveConnectorAgentRequest).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Check if it’s done' }));
    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'current_access',
        connectionId: 'connection-1',
        eventScopes: [],
      })
    );
    expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledTimes(1);
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });

  it('keeps the question once shown even when the account then needs a review', async () => {
    const user = userEvent.setup();
    const ready = account('connection-1');
    const moved = {
      ...ready,
      reconciliationStatus: 'migration_needs_reconcile' as const,
      readiness: needs('needs_review', 'review_access', 'Check who can use it.'),
    };
    const transport = transportWith([ready]);
    vi.mocked(transport.getConnectorConnections)
      .mockResolvedValueOnce({ connections: [ready] })
      .mockResolvedValue({ connections: [moved] });
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'migration_needs_reconcile',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'], level: 'read' }],
    });
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(vi.mocked(transport.getConnectorConnections).mock.calls.length).toBeGreaterThanOrEqual(
        2
      )
    );
    // The shared card reports its own outcome; the readiness gate stays out of it.
    expect(await screen.findByText('Access needs review')).toBeInTheDocument();
    expect(screen.queryByTestId('account-attention')).not.toBeInTheDocument();
  });

  it("does not block an account whose only pending sync is another agent's", async () => {
    const transport = transportWith([
      {
        ...account('connection-1'),
        authoritySync: { status: 'pending' },
        readiness: needs('access_updating', 'wait', 'Updating who can use it…', 'finishing'),
      },
    ]);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);
    expect(await screen.findByRole('heading', { name: 'Let Bo use Gmail?' })).toBeInTheDocument();
    expect(screen.queryByTestId('account-attention')).not.toBeInTheDocument();
  });

  it('asks for the review, not an Allow, when a change to who can use it was refused', async () => {
    const transport = transportWith([
      {
        ...account('connection-1'),
        authoritySync: { status: 'failed', reason: 'Refused.' },
        readiness: needs('access_update_failed', 'review_access', 'A change didn’t go through.'),
      },
    ]);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);
    expect(await screen.findByTestId('account-attention')).toHaveAttribute(
      'data-reason',
      'access_update_failed'
    );
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Connections/ })).toHaveAttribute(
      'href',
      expect.stringContaining('app=connection-1')
    );
  });

  it('never starts below the level the agent already holds', async () => {
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([
        { agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'send-v1'], level: 'read-write' },
      ])
    );
    renderWith(transport, <AgentRequestCard request={REQUEST} />);
    await screen.findByTestId('requested-access');
    // It asked only to read, but already reads and writes: the card says so and
    // offers nothing lower.
    expect(screen.getByText('Bo can already do this.')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Read' })).not.toBeInTheDocument();
    expect(screen.getByText('Read and write')).toBeInTheDocument();
  });
});

describe('AgentRequestCard — access through "Every agent"', () => {
  it('recognises access every agent already has and answers with it, writing nothing', async () => {
    const user = userEvent.setup();
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue({
      ...preview(),
      everyAgent: { available: true, operationRevisionIds: ['read-v1'], level: 'read' },
    });
    vi.mocked(transport.resolveConnectorAgentRequest).mockResolvedValue({
      ...REQUEST,
      status: 'granted',
    } as never);
    renderWith(transport, <AgentRequestCard request={REQUEST} />);

    expect(
      await screen.findByText('Bo can already do this, because every agent can.')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(transport.resolveConnectorAgentRequest).toHaveBeenCalledWith('request-1', {
        decision: 'current_access',
        connectionId: 'connection-1',
        eventScopes: [],
      })
    );
    expect(transport.applyConnectorReconciliation).not.toHaveBeenCalled();
  });

  it('ignores an "Every agent" grant the server would not honour', async () => {
    const transport = transportWith([account('connection-1')]);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue({
      ...preview(),
      everyAgent: { available: false, operationRevisionIds: ['read-v1'], level: 'read' },
    });
    renderWith(transport, <AgentRequestCard request={REQUEST} />);
    await screen.findByRole('heading', { name: 'Let Bo use Gmail?' });
    await screen.findByRole('button', { name: 'Allow' });
    expect(screen.queryByText(/because every agent can/)).not.toBeInTheDocument();
  });
});
