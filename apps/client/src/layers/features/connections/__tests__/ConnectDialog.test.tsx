/** @vitest-environment jsdom */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConnectorAuthenticationSetup,
  ConnectorProviderStatus,
} from '@dorkos/shared/connector-provider';
import type {
  ConnectorAppConnections,
  ConnectorCatalogProviderRoute,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectDialog } from '../ui/ConnectDialog';

const openSettings = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));

/** The providers read's answer: these statuses, and (unless given) nothing set up for new apps. */
function providersFrom(
  // Loose on purpose: these fixtures carry only the fields the dialog reads.
  providers: readonly Partial<ConnectorProviderStatus>[],
  appConnections: ConnectorAppConnections = {
    ways: [],
    newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
  }
) {
  return vi.fn().mockResolvedValue({ providers, appConnections });
}

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

const CONNECTED_PREVIEW: ConnectorReconciliationPreview = {
  previewId: 'preview-1',
  connection: {
    connectionId: 'connection-1' as never,
    toolkit: 'gmail',
    label: 'work',
    status: 'active',
    custody: 'managed',
    reconciliationStatus: 'ready',
  },
  candidates: [],
  agents: [{ agentId: 'agent-a', displayName: 'Ada' }],
  currentGrants: [],
  everyAgent: { available: true, operationRevisionIds: [] },
  catalogComplete: true,
  createdAt: '2026-09-06T00:00:00.000Z',
  expiresAt: '2099-09-06T01:00:00.000Z',
};

function renderDialog(
  transport = createMockTransport(),
  service: typeof gmail | null = gmail,
  initialFlowId: string | null = null
) {
  const chooseAccess = vi.fn();
  function Host() {
    const [flowId, setFlowId] = useState<string | null>(initialFlowId);
    return (
      <ConnectDialog
        service={service}
        flowId={flowId}
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
  it.each([
    [
      'your own Composio key',
      'managed' as const,
      'Any usage charges go to your own Composio account.',
    ],
    ['your own Nango server', 'self-host' as const, null],
  ])('says who pays only when someone does: %s', (_way, custody, line) => {
    const base = managedService(undefined, capabilities.authentication, 'byo');
    const account = base.intents[0]!;
    const service: ConnectorCatalogService = {
      ...base,
      intents: [
        {
          ...account,
          routes: account.kind === 'account' ? [{ ...account.routes[0]!, custody }] : [],
        } as typeof account,
      ],
    };
    renderDialog(createMockTransport(), service);

    const disclosure = screen.getByTestId('connect-disclosure');
    expect(disclosure).not.toHaveTextContent('billed to you');
    expect(disclosure).not.toHaveTextContent('covers its use');
    if (line) expect(disclosure).toHaveTextContent(line);
    else expect(disclosure).not.toHaveTextContent(/usage charges/);
  });

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
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(CONNECTED_PREVIEW);
    const { chooseAccess } = renderDialog(transport);

    expect(screen.getAllByText('Composio holds the service connection in its vault.')).toHaveLength(
      1
    );
    expect(screen.getByTestId('connect-disclosure')).toHaveTextContent(
      'A sign-in page opens next, where you let DorkOS use Gmail.'
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(transport.startConnectorAuthentication).toHaveBeenCalledWith(
        expect.objectContaining({ providerInstanceId: 'managed-1', toolkit: 'gmail' })
      )
    );
    expect(await screen.findByText('Gmail is connected')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Who can use Gmail?' })).toBeInTheDocument();
    expect(transport.previewConnectorReconciliation).toHaveBeenCalledWith({
      connectionId: 'connection-1',
    });
    await user.click(await screen.findByRole('button', { name: 'Choose exact actions' }));
    expect(chooseAccess).toHaveBeenCalledWith('connection-1');
  });

  it('lets the owner skip choosing agents, which ends the saved connection flow', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
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
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(CONNECTED_PREVIEW);
    const { chooseAccess } = renderDialog(transport, gmail, 'flow-1');

    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(chooseAccess).not.toHaveBeenCalled();
    expect(transport.applyConnectorReconciliation).not.toHaveBeenCalled();
    expect(screen.queryByTestId('connect-auth-dialog')).not.toBeInTheDocument();
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
      screen.getByText(
        'Enter the account details Linear asks for on dorkos.ai. DorkOS passes them on without saving them.'
      )
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
      screen.getByText('Linear signs in with the sign-in page set up for it.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('never dead-ends on a route that cannot sign in: it offers another way, with the reason', async () => {
    // The pre-DOR-1798 case: the DorkOS-account route answers but cannot sign in to apps.
    renderDialog(
      createMockTransport({
        getConnectorProviders: providersFrom([
          {
            type: 'composio',
            configured: false,
            registered: false,
            custody: 'managed',
            disclosure: 'Composio keeps sign-ins.',
          },
        ]),
      }),
      managedService(undefined, {
        status: 'unsupported',
        reason: 'Signing in to apps through your DorkOS account isn’t available yet.',
      })
    );

    expect(await screen.findByTestId('first-connect-step')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Signing in to apps through your DorkOS account isn’t available yet.'
    );
    expect(screen.getByRole('button', { name: /Use my Composio key/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });

  it('preserves an explicit provider choice and never starts an unavailable route', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorAuthentication).mockReturnValue(new Promise(() => undefined));
    renderDialog(transport);

    await user.click(screen.getByRole('button', { name: 'Connect another way' }));
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

  describe('the first connect', () => {
    const builtInGmail: ConnectorCatalogService = {
      serviceSlug: 'gmail',
      displayName: 'Gmail',
      iconKey: 'gmail',
      description: 'Read, search and send email.',
      category: 'email',
      popular: true,
      signInName: 'Google',
      intents: [{ kind: 'account', displayName: 'Use a Gmail account', routes: [] }],
    };
    const composioRoute: ConnectorCatalogProviderRoute = {
      providerInstanceId: 'composio-1' as never,
      displayName: 'composio',
      mode: 'byo',
      custody: 'managed',
      payer: 'operator_byo',
      capabilities,
      disclosure: 'Composio stores your connected accounts’ login access.',
      authKind: 'oauth2',
      signInThrough: 'Composio',
    };
    const statuses = [
      {
        type: 'composio',
        configured: false,
        registered: false,
        custody: 'managed' as const,
        disclosure: 'Composio keeps sign-ins.',
      },
      {
        type: 'nango',
        configured: false,
        registered: false,
        custody: 'self-host' as const,
        disclosure: 'Nango keeps sign-ins on your server.',
      },
    ];

    it('asks how DorkOS reaches apps once, then goes straight to sign-in after a key works', async () => {
      const user = userEvent.setup();
      const transport = createMockTransport({
        getConnectorProviders: providersFrom(statuses),
        putConnectorCredential: vi
          .fn()
          .mockResolvedValue({ ...statuses[0], configured: true, registered: true }),
      });
      const unreached = {
        services: [builtInGmail],
        warnings: [],
        appConnections: {
          ways: [],
          newApps: { status: 'setup_needed' as const, reason: 'nothing_set_up' as const },
        },
      };
      const way = {
        kind: 'own_key' as const,
        type: 'composio',
        status: 'ready' as const,
        providerInstanceId: 'composio-1' as never,
        signInThrough: 'Composio',
      };
      vi.mocked(transport.getConnectorCatalog).mockResolvedValue(unreached);
      renderDialog(transport, builtInGmail);

      const step = await screen.findByTestId('first-connect-step');
      expect(screen.getByText(/First, pick how DorkOS reaches your apps/)).toBeInTheDocument();
      // Nothing is set up, which needs no explaining.
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      // No sign-in can start from here, and nothing names a plan or a price.
      expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
      expect(step).not.toHaveTextContent(/\$|plan|price/i);
      // Nango is folded under Other ways until asked for.
      expect(screen.queryByText(/My own Nango server/)).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Other ways' }));
      expect(screen.getByText(/My own Nango server/)).toBeVisible();

      vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
        services: [
          {
            ...builtInGmail,
            intents: [
              { kind: 'account', displayName: 'Use a Gmail account', routes: [composioRoute] },
            ],
          },
        ],
        warnings: [],
        appConnections: { ways: [way], newApps: { status: 'ready', way } },
      });
      await user.click(screen.getByRole('button', { name: /Use my Composio key/ }));
      await user.type(screen.getByLabelText('Composio project key'), 'ck-test');
      await user.click(
        within(screen.getByTestId('provider-card-composio')).getByRole('button', {
          name: 'Save key',
        })
      );

      // The saved key refreshes the list; the step is gone and sign-in is next.
      expect(await screen.findByTestId('connect-sign-in-line')).toHaveTextContent(
        'Google will ask you to allow Composio — that’s the service DorkOS uses to connect.'
      );
      expect(screen.queryByTestId('first-connect-step')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });

    it('says in one line why the step shows when a linked DorkOS account cannot connect apps', async () => {
      const transport = createMockTransport({
        getConnectorProviders: providersFrom(statuses),
      });
      vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
        services: [builtInGmail],
        warnings: [],
        appConnections: {
          ways: [
            {
              kind: 'dorkos_account',
              type: 'dorkos-managed',
              status: 'unavailable',
              signInThrough: 'Composio',
            },
          ],
          newApps: { status: 'setup_needed', reason: 'dorkos_account_unavailable' },
        },
      });
      renderDialog(transport, builtInGmail);

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Your DorkOS account is linked, but it can’t connect apps right now.'
      );
      expect(screen.getByRole('button', { name: /Use my Composio key/ })).toBeInTheDocument();
    });

    it('closes itself before Settings opens to link the DorkOS account again', async () => {
      const user = userEvent.setup();
      const unlinked: ConnectorAppConnections = {
        ways: [{ kind: 'dorkos_account', type: 'dorkos-managed', status: 'unlinked' }],
        newApps: { status: 'setup_needed', reason: 'dorkos_account_unlinked' },
      };
      const transport = createMockTransport({
        getConnectorProviders: providersFrom(statuses, unlinked),
      });
      vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
        services: [builtInGmail],
        warnings: [],
        appConnections: unlinked,
      });
      const order: string[] = [];
      const onClose = vi.fn(() => order.push('closed'));
      openSettings.mockReset().mockImplementation(() => order.push('settings'));
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <TransportProvider transport={transport}>
            <ConnectDialog
              service={builtInGmail}
              flowId={null}
              onFlowIdChange={() => undefined}
              onClose={onClose}
              onChooseAccess={() => undefined}
            />
          </TransportProvider>
        </QueryClientProvider>
      );

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Your DorkOS account isn’t linked anymore.'
      );
      await user.click(screen.getByRole('button', { name: 'Link my DorkOS account again' }));
      // No stacked dialogs: the Connect dialog is gone before Settings opens.
      expect(order).toEqual(['closed', 'settings']);
      expect(openSettings).toHaveBeenCalledWith('account');
      await waitFor(() =>
        expect(screen.queryByTestId('connect-auth-dialog')).not.toBeInTheDocument()
      );
    });

    it('says to try again, not to set up, when a working way could not be reached', async () => {
      const user = userEvent.setup();
      const transport = createMockTransport({
        getConnectorProviders: providersFrom(statuses),
      });
      const way = {
        kind: 'own_key' as const,
        type: 'composio',
        status: 'ready' as const,
        providerInstanceId: 'composio-1' as never,
        signInThrough: 'Composio',
      };
      vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
        services: [builtInGmail],
        warnings: [
          {
            code: 'catalog_provider_unavailable',
            message:
              'Your Composio key didn’t answer, so its apps aren’t shown. Try again in a moment.',
          },
        ],
        appConnections: { ways: [way], newApps: { status: 'ready', way } },
      });
      renderDialog(transport, builtInGmail);

      expect(await screen.findByText('Couldn’t reach Gmail just now')).toBeInTheDocument();
      expect(screen.getByText(/Your Composio key didn’t answer/)).toBeInTheDocument();
      expect(screen.queryByTestId('first-connect-step')).not.toBeInTheDocument();
      const reads = vi.mocked(transport.getConnectorCatalog).mock.calls.length;
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() =>
        expect(vi.mocked(transport.getConnectorCatalog).mock.calls.length).toBeGreaterThan(reads)
      );
    });

    it('keeps a route’s real reason when an unrelated catalog warning arrives beside it', async () => {
      const transport = createMockTransport({
        getConnectorProviders: providersFrom(statuses),
      });
      const way = {
        kind: 'own_key' as const,
        type: 'composio',
        status: 'ready' as const,
        providerInstanceId: 'composio-1' as never,
        signInThrough: 'Composio',
      };
      vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
        services: [
          {
            ...builtInGmail,
            intents: [
              {
                kind: 'account',
                displayName: 'Use a Gmail account',
                routes: [
                  {
                    ...composioRoute,
                    capabilities: {
                      ...capabilities,
                      authentication: {
                        status: 'unsupported',
                        reason: 'Gmail sign-in is not available through this key.',
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
        warnings: [
          {
            code: 'catalog_provider_unavailable',
            message:
              'Your Nango server didn’t answer, so its apps aren’t shown. Try again in a moment.',
          },
        ],
        appConnections: { ways: [way], newApps: { status: 'ready', way } },
      });
      renderDialog(transport, builtInGmail);

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Gmail sign-in is not available through this key.'
      );
      expect(screen.queryByText('Couldn’t reach Gmail just now')).not.toBeInTheDocument();
    });

    it('names the DorkOS account, not Composio, when that account cannot reach the app', async () => {
      const transport = createMockTransport({
        getConnectorProviders: providersFrom(statuses),
      });
      const way = {
        kind: 'dorkos_account' as const,
        type: 'dorkos-managed',
        status: 'ready' as const,
        providerInstanceId: 'managed-1' as never,
        signInThrough: 'Composio',
      };
      vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
        services: [builtInGmail],
        warnings: [],
        appConnections: { ways: [way], newApps: { status: 'ready', way } },
      });
      renderDialog(transport, builtInGmail);

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Your DorkOS account can’t reach Gmail yet.'
      );
    });

    it('uses the way marked for new apps without asking, preferring the person’s own key', async () => {
      const transport = createMockTransport();
      const way = {
        kind: 'own_key' as const,
        type: 'composio',
        status: 'ready' as const,
        providerInstanceId: 'byo-1' as never,
      };
      // `gmail` lists the DorkOS-account route first; the marked way still wins.
      vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
        services: [gmail],
        warnings: [],
        appConnections: { ways: [way], newApps: { status: 'ready', way } },
      });
      renderDialog(transport);

      await waitFor(() =>
        expect(screen.getByTestId('connect-disclosure')).toHaveTextContent('My provider')
      );
      expect(screen.queryByTestId('first-connect-step')).not.toBeInTheDocument();
    });
  });
});
