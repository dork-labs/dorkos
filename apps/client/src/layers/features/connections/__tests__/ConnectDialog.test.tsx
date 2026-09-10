/** @vitest-environment jsdom */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorAuthenticationSetup } from '@dorkos/shared/connector-provider';
import type {
  ConnectorCatalogProviderRoute,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectDialog } from '../ui/ConnectDialog';

afterEach(cleanup);

const capabilities = {
  catalog: { status: 'available' as const },
  authentication: { status: 'available' as const },
  accounts: { status: 'available' as const },
  operations: { status: 'available' as const },
  execution: { status: 'available' as const },
  triggers: { status: 'unsupported' as const, reason: 'Events arrive in a later release.' },
};

const gmail: ConnectorCatalogService = {
  serviceSlug: 'gmail',
  displayName: 'Gmail',
  iconKey: 'gmail',
  intents: [
    {
      kind: 'account',
      displayName: 'Use a Gmail account',
      routes: [
        {
          providerInstanceId: 'byo-1' as never,
          displayName: 'My provider',
          mode: 'byo',
          custody: 'self-host',
          payer: 'operator_byo',
          capabilities,
          disclosure: 'Your account stores login access.',
          authKind: 'oauth2',
        },
        {
          providerInstanceId: 'managed-1' as never,
          displayName: 'DorkOS managed',
          mode: 'managed',
          custody: 'managed',
          payer: 'dorkos_managed',
          capabilities,
          disclosure: 'Composio holds the service connection in its vault.',
          authKind: 'oauth2',
          authenticationSetup: {
            kind: 'oauth',
            source: 'managed',
            scheme: 'OAUTH2',
            requiresAccountFields: false,
          },
        },
        {
          providerInstanceId: 'offline-1' as never,
          displayName: 'Unavailable provider',
          mode: 'byo',
          custody: 'external',
          payer: 'operator_byo',
          capabilities: {
            ...capabilities,
            authentication: { status: 'unsupported', reason: 'Provider is not configured.' },
          },
          disclosure: 'This provider would keep login access.',
          authKind: 'oauth2',
        },
      ],
    },
  ],
};

function renderDialog(
  transport = createMockTransport(),
  service: typeof gmail | null = gmail,
  agentRequestId: string | null = null,
  initialFlowId: string | null = null
) {
  const chooseAccess = vi.fn();
  function Host() {
    const [flowId, setFlowId] = useState<string | null>(initialFlowId);
    return (
      <ConnectDialog
        service={service}
        flowId={flowId}
        agentRequestId={agentRequestId}
        onFlowIdChange={setFlowId}
        onClose={() => undefined}
        onChooseAccess={chooseAccess}
      />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <Host />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, chooseAccess };
}

function managedService(
  authenticationSetup: ConnectorAuthenticationSetup | undefined,
  authentication: ConnectorCatalogProviderRoute['capabilities']['authentication'] = capabilities.authentication,
  mode: ConnectorCatalogProviderRoute['mode'] = 'managed'
): ConnectorCatalogService {
  return {
    serviceSlug: 'linear',
    displayName: 'Linear',
    iconKey: 'linear',
    intents: [
      {
        kind: 'account',
        displayName: 'Use a Linear account',
        routes: [
          {
            providerInstanceId: 'managed-1' as never,
            displayName: 'DorkOS managed',
            mode,
            custody: mode === 'managed' ? 'managed' : 'self-host',
            payer: mode === 'managed' ? 'dorkos_managed' : 'operator_byo',
            capabilities: { ...capabilities, authentication },
            disclosure: 'Composio holds the service connection in its vault.',
            authKind:
              authenticationSetup?.kind === 'oauth'
                ? 'oauth2'
                : authenticationSetup?.kind === 'fields'
                  ? 'api-key'
                  : 'none',
            ...(authenticationSetup && { authenticationSetup }),
          },
        ],
      },
    ],
  };
}

describe('ConnectDialog', () => {
  it('defaults to an available managed route, discloses custody, then waits for explicit agent access', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'pending',
      authorizeUrl: 'https://provider.example/auth',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
    });
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'connected',
      connectionId: 'connection-1' as never,
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
      completedAt: '2026-09-06T00:01:00.000Z',
    });
    const { chooseAccess } = renderDialog(transport);

    expect(screen.getAllByText('Composio holds the service connection in its vault.')).toHaveLength(
      1
    );
    expect(screen.getByTestId('connect-disclosure')).toHaveTextContent(
      'Continue to Composio to approve access to Gmail'
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(transport.startConnectorAuthentication).toHaveBeenCalledWith(
        expect.objectContaining({ providerInstanceId: 'managed-1', toolkit: 'gmail' })
      )
    );
    expect(await screen.findByText('Gmail is connected')).toBeInTheDocument();
    expect(screen.getByText(/No agent can use it/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Choose agents/i }));
    expect(chooseAccess).toHaveBeenCalledWith('connection-1');
  });

  it('keeps account fields on the hosted owner page and out of the local dialog', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    const pending = {
      flowId: 'flow-fields',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'linear',
      state: 'pending' as const,
      authorizeUrl: 'https://dorkos.ai/connectors/managed/authorize?flow=opaque',
      createdAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-09T00:10:00.000Z',
    };
    vi.mocked(transport.startConnectorAuthentication).mockResolvedValue(pending);
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue(pending);
    renderDialog(
      transport,
      managedService({
        kind: 'fields',
        source: 'account-fields',
        scheme: 'BEARER_TOKEN',
        requiresAccountFields: true,
      })
    );

    expect(
      screen.getByText(/Enter the account details requested by Linear on dorkos.ai/)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/API key|token|password/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enter account details' }));
    expect(await screen.findByRole('link', { name: 'Enter account details' })).toHaveAttribute(
      'href',
      pending.authorizeUrl
    );
  });

  it('requires explicit owner confirmation for a no-auth service', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorAuthentication).mockReturnValue(new Promise(() => undefined));
    renderDialog(
      transport,
      managedService({
        kind: 'none',
        source: 'account-fields',
        scheme: 'NO_AUTH',
        requiresAccountFields: false,
      })
    );

    expect(screen.getByText(/No account details are needed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review and confirm' }));
    expect(transport.startConnectorAuthentication).toHaveBeenCalledTimes(1);
  });

  it('does not promise the hosted account form for a bring-your-own route', () => {
    renderDialog(
      createMockTransport(),
      managedService(
        {
          kind: 'fields',
          source: 'account-fields',
          scheme: 'API_KEY',
          requiresAccountFields: true,
        },
        capabilities.authentication,
        'byo'
      )
    );

    expect(screen.queryByText(/on dorkos.ai/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('explains that an explicit custom setup takes precedence', () => {
    renderDialog(
      createMockTransport(),
      managedService({
        kind: 'unsupported',
        source: 'configured',
        scheme: 'DCR',
        requiresAccountFields: false,
      })
    );

    expect(
      screen.getByText(/uses the custom sign-in setup configured for this service/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('keeps an unsupported declared method visible and unavailable', () => {
    renderDialog(
      createMockTransport(),
      managedService(
        {
          kind: 'unsupported',
          source: 'unsupported',
          scheme: 'OAUTH1',
          requiresAccountFields: false,
        },
        {
          status: 'unsupported',
          reason: 'This service uses OAUTH1, which DorkOS does not support yet.',
        }
      )
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This service uses OAUTH1, which DorkOS does not support yet.'
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('preserves an explicit provider choice and never starts an unavailable route', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorAuthentication).mockReturnValue(new Promise(() => undefined));
    renderDialog(transport);

    await user.click(screen.getByRole('button', { name: 'Change setup' }));
    expect(screen.getByRole('button', { name: /Unavailable provider/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /My provider/i }));
    expect(screen.getByTestId('connect-disclosure')).toHaveTextContent('Your account stores');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(transport.startConnectorAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({ providerInstanceId: 'byo-1' })
    );
  });

  it('keeps custody visible beside a pending provider sign-in', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    const pending = {
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'pending' as const,
      authorizeUrl: 'https://provider.example/auth',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
    };
    vi.mocked(transport.startConnectorAuthentication).mockResolvedValue(pending);
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue(pending);
    renderDialog(transport);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('link', { name: 'Open sign-in' })).toBeInTheDocument();
    expect(screen.getAllByText('Composio holds the service connection in its vault.')).toHaveLength(
      1
    );
  });

  it('will not carry an authorize URL naming a scheme the app refuses (DOR-924)', async () => {
    // `authorizeUrl` is whatever the connector flow answered with. It was a
    // bare `<a href>`, so the browser followed it with none of the app's link
    // policy in the path — including on a middle-click or "Copy Link Address",
    // which no click handler can intercept.
    const user = userEvent.setup();
    const transport = createMockTransport();
    const pending = {
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'pending' as const,
      authorizeUrl: 'data:text/html,<script>alert(1)</script>',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
    };
    vi.mocked(transport.startConnectorAuthentication).mockResolvedValue(pending);
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue(pending);
    renderDialog(transport);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const action = await screen.findByText('Open sign-in');
    expect(action.closest('a')?.hasAttribute('href')).toBe(false);
  });

  it('keeps authentication associated with the exact agent request until explicit access review', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorAgentRequestAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'pending',
      authorizeUrl: 'https://provider.example/auth',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
    });
    vi.mocked(transport.pollConnectorAgentRequestAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'connected',
      connectionId: 'connection-1' as never,
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
      completedAt: '2026-09-06T00:01:00.000Z',
    });
    const { chooseAccess } = renderDialog(transport, gmail, 'request-1');

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(transport.startConnectorAgentRequestAuthentication).toHaveBeenCalledWith(
        'request-1',
        expect.objectContaining({ providerInstanceId: 'managed-1' })
      )
    );
    expect(transport.startConnectorAuthentication).not.toHaveBeenCalled();
    expect(await screen.findByText('Gmail is connected')).toBeInTheDocument();
    expect(screen.getByText(/Return to the request to choose its exact actions/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Review requested access' }));
    expect(chooseAccess).toHaveBeenCalledWith('connection-1');
  });

  it('resumes the request-bound flow from its URL identities after a refresh', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.pollConnectorAgentRequestAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'connected',
      connectionId: 'connection-1' as never,
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
      completedAt: '2026-09-06T00:01:00.000Z',
    });

    renderDialog(transport, null, 'request-1', 'flow-1');

    expect(await screen.findByText('Gmail is connected')).toBeInTheDocument();
    expect(transport.pollConnectorAgentRequestAuthentication).toHaveBeenCalledWith(
      'request-1',
      'flow-1'
    );
    expect(transport.pollConnectorAuthentication).not.toHaveBeenCalled();
  });
});
