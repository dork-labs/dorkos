/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

import { AccountsList } from '../ui/AccountsList';
import { ConnectionDetailSheet } from '../ui/ConnectionDetailSheet';
import { ServiceGrid } from '../ui/ServiceGrid';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useRouter: () => ({}) }));
const openSettings = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));
afterEach(() => {
  cleanup();
});

function renderWith(transport: Transport, ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}

const capabilities = {
  catalog: { status: 'available' as const },
  authentication: { status: 'available' as const },
  accounts: { status: 'available' as const },
  operations: { status: 'available' as const },
  execution: { status: 'available' as const },
  triggers: { status: 'unsupported' as const, reason: 'Unavailable' },
};

function connection(over: Partial<ConnectorConnectionSummary> = {}): ConnectorConnectionSummary {
  return {
    connectionId: 'connection-1' as never,
    providerInstanceId: 'provider-1' as never,
    toolkit: 'gmail',
    label: 'work',
    identityHint: 'work@example.com',
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'managed',
    custody: 'managed',
    payer: 'dorkos_managed',
    agentCount: 2,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 3, attemptCount: 4 },
    warnings: [],
    ...over,
  };
}

describe('ServiceGrid', () => {
  it('searches one catalog and keeps Slack message and account intents distinct', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
      services: [
        {
          serviceSlug: 'slack',
          displayName: 'Slack',
          iconKey: 'slack',
          intents: [
            {
              kind: 'messages',
              displayName: 'Messages through a Slack bot',
              relayAdapterType: 'slack',
            },
            {
              kind: 'account',
              displayName: 'Use a Slack account',
              routes: [
                {
                  providerInstanceId: 'managed-1' as never,
                  displayName: 'DorkOS managed',
                  mode: 'managed',
                  custody: 'managed',
                  payer: 'dorkos_managed',
                  capabilities,
                  disclosure: 'Managed custody.',
                  authKind: 'oauth2',
                },
              ],
            },
          ],
        },
      ],
      warnings: [],
    });
    const onConnect = vi.fn();
    const onConnectChat = vi.fn();
    renderWith(transport, <ServiceGrid onConnect={onConnect} onConnectChat={onConnectChat} />);
    await user.click(screen.getByRole('button', { name: 'Connect service' }));
    await user.type(screen.getByRole('textbox', { name: 'Search services' }), 'Slack');
    await user.click(await screen.findByRole('button', { name: 'Use a Slack account' }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ serviceSlug: 'slack' }));
    expect(onConnectChat).not.toHaveBeenCalled();
    expect(transport.getConnectorCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Slack', limit: 24 })
    );

    // The chat intent goes to the chat app's own setup, not the sign-in flow.
    await user.click(screen.getByRole('button', { name: 'Connect service' }));
    await user.click(await screen.findByRole('button', { name: 'Messages through a Slack bot' }));
    expect(onConnectChat).toHaveBeenCalledWith('slack');
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('lists popular apps with a line about each, and tags chat apps, with nothing set up', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
      services: [
        {
          serviceSlug: 'gmail',
          displayName: 'Gmail',
          iconKey: 'gmail',
          description: 'Read, search and send email.',
          category: 'email',
          popular: true,
          signInName: 'Google',
          intents: [{ kind: 'account', displayName: 'Use a Gmail account', routes: [] }],
        },
        {
          serviceSlug: 'telegram',
          displayName: 'Telegram',
          iconKey: 'telegram',
          description: 'Talk to your agents through your own Telegram bot.',
          category: 'chat',
          popular: true,
          intents: [
            {
              kind: 'messages',
              displayName: 'Messages through a Telegram bot',
              relayAdapterType: 'telegram',
            },
          ],
        },
      ],
      warnings: [],
      appConnections: { ways: [], newApps: { status: 'setup_needed', reason: 'nothing_set_up' } },
    });
    const onConnect = vi.fn();
    renderWith(transport, <ServiceGrid onConnect={onConnect} onConnectChat={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Connect service' }));

    const gmail = await screen.findByTestId('service-result-gmail');
    expect(gmail).toHaveTextContent('Read, search and send email.');
    expect(gmail).not.toHaveTextContent('Chat');
    expect(screen.getByTestId('service-result-telegram')).toHaveTextContent('Chat');
    // Nothing set up is not a reason to hide the app: Connect still leads somewhere.
    await user.click(screen.getByRole('button', { name: 'Use a Gmail account' }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ serviceSlug: 'gmail' }));
  });

  it('says why a search finds nothing while no way to reach apps is set up', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
      services: [],
      warnings: [],
      appConnections: { ways: [], newApps: { status: 'setup_needed', reason: 'nothing_set_up' } },
    });
    renderWith(
      transport,
      <ServiceGrid onConnect={() => undefined} onConnectChat={() => undefined} />
    );

    await user.click(screen.getByRole('button', { name: 'Connect service' }));
    await user.type(screen.getByRole('textbox', { name: 'Search services' }), 'Zendesk');
    expect(await screen.findByText('No app matches “Zendesk”')).toBeInTheDocument();
    expect(
      screen.getByText(/Only popular apps are listed until you connect your first one/)
    ).toBeInTheDocument();
    // Nothing set up is answered by connecting, not by a trip to Settings.
    expect(screen.queryByRole('button', { name: 'Open Settings › Connections' })).toBeNull();
  });

  it('does not promise the first connect fixes search when a saved key stopped working', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
      services: [],
      warnings: [],
      appConnections: {
        ways: [{ kind: 'own_key', type: 'composio', status: 'unavailable' }],
        newApps: { status: 'setup_needed', reason: 'own_key_unavailable' },
      },
    });
    renderWith(
      transport,
      <ServiceGrid onConnect={() => undefined} onConnectChat={() => undefined} />
    );

    await user.click(screen.getByRole('button', { name: 'Connect service' }));
    expect(
      await screen.findByText('Only popular apps are listed while your saved key isn’t working.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/until you connect your first one/)).not.toBeInTheDocument();
    // The fix for a key that stopped working lives in Settings › Connections.
    await user.click(screen.getByRole('button', { name: 'Open Settings › Connections' }));
    // The catalog steps aside for Settings rather than stacking a modal on it.
    expect(screen.queryByRole('dialog', { name: 'Connect a service' })).not.toBeInTheDocument();
    expect(openSettings).toHaveBeenCalledWith('connections', 'ways');
  });

  it('keeps an empty search plain once a way to reach apps works', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({ services: [], warnings: [] });
    renderWith(
      transport,
      <ServiceGrid onConnect={() => undefined} onConnectChat={() => undefined} />
    );

    await user.click(screen.getByRole('button', { name: 'Connect service' }));
    expect(await screen.findByText('Try another name.')).toBeInTheDocument();
    expect(screen.queryByText(/Only popular apps are listed/)).not.toBeInTheDocument();
  });

  it('keeps a catalog error separate from an empty result and offers a retry', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog).mockRejectedValue(new Error('catalog offline'));
    renderWith(
      transport,
      <ServiceGrid onConnect={() => undefined} onConnectChat={() => undefined} />
    );

    await user.click(screen.getByRole('button', { name: 'Connect service' }));
    expect(await screen.findByText('Couldn’t load services')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/No app matches/)).not.toBeInTheDocument();
  });
});

describe('AccountsList', () => {
  it('shows several stable accounts as concise rows and opens the exact detail id', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({
      connections: [
        connection(),
        connection({ connectionId: 'connection-2' as never, label: 'personal', agentCount: 0 }),
      ],
    });
    const onOpenDetail = vi.fn();
    renderWith(transport, <AccountsList onOpenDetail={onOpenDetail} />);
    await user.click(await screen.findByRole('button', { name: /Gmail \(personal\)/i }));
    expect(onOpenDetail).toHaveBeenCalledWith('connection-2');
    expect(screen.getByText(/2 agents · Managed/)).toBeInTheDocument();
    expect(screen.getByText(/0 agents · Managed/)).toBeInTheDocument();
  });

  it('distinguishes review, pending synchronization, and failed synchronization', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({
      connections: [
        connection({
          connectionId: 'pending-connection' as never,
          label: 'pending',
          authoritySync: { status: 'pending' },
          usage: { status: 'unavailable', reason: 'Usage source timed out.' },
        }),
        connection({
          connectionId: 'failed-connection' as never,
          label: 'failed',
          authoritySync: { status: 'failed', reason: 'Provider rejected the update.' },
        }),
        connection({
          connectionId: 'review-connection' as never,
          label: 'review',
          reconciliationStatus: 'migration_needs_reconcile',
        }),
      ],
    });
    renderWith(transport, <AccountsList onOpenDetail={() => undefined} />);
    expect(await screen.findByText('Syncing')).toBeInTheDocument();
    expect(screen.getByText('Sync failed')).toBeInTheDocument();
    expect(screen.getByText('Review needed')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('labels disconnected accounts without treating active authentication as ready', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({
      connections: [connection({ lifecycle: 'disconnected' })],
    });
    renderWith(transport, <AccountsList onOpenDetail={() => undefined} />);
    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });
});

describe('ConnectionDetailSheet', () => {
  it.each(['unknown', 'pending', 'failed'] as const)(
    'keeps sign-in and removal closed during %s cleanup and offers owner recovery',
    async (externalCleanup) => {
      const transport = createMockTransport();
      vi.mocked(transport.getConnectorConnection).mockResolvedValue({
        connection: connection({ lifecycle: 'disconnected', externalCleanup }),
        provider: {
          providerInstanceId: 'provider-1' as never,
          displayName: 'DorkOS managed',
          mode: 'managed',
          custody: 'managed',
          payer: 'dorkos_managed',
          capabilities,
          disclosure: 'DorkOS stores login access in its secure vault.',
        },
        agents: [],
        sessions: { affectedCount: 0 },
        subscriptions: {
          totalCount: 0,
          activeCount: 0,
          capability: { status: 'unsupported', reason: 'Unavailable' },
        },
      });
      renderWith(
        transport,
        <ConnectionDetailSheet
          connectionId="connection-1"
          onClose={() => undefined}
          onManageAccess={() => undefined}
          onReconnect={() => undefined}
        />
      );
      expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Remove from Accounts' })).toBeDisabled();
      expect(
        screen.getByRole('button', {
          name: externalCleanup === 'failed' ? 'Try disconnecting again' : 'Finish disconnecting',
        })
      ).toBeEnabled();
      expect(transport.disconnectConnectorConnection).not.toHaveBeenCalled();
    }
  );

  it('shows honest unavailable states and exact impact before disconnecting', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnection).mockResolvedValue({
      connection: connection({
        authoritySync: { status: 'failed', reason: 'Provider rejected the update.' },
        usage: { status: 'unavailable', reason: 'Provider does not report usage.' },
      }),
      provider: {
        providerInstanceId: 'provider-1' as never,
        displayName: 'DorkOS managed',
        mode: 'managed',
        custody: 'managed',
        payer: 'dorkos_managed',
        capabilities,
        disclosure: 'DorkOS stores login access in its secure vault.',
      },
      agents: [
        {
          agentId: 'agent-1',
          displayName: 'Researcher',
          operationRevisionIds: ['operation-1'],
          classifications: ['read'],
          reconciliationStatus: 'ready',
          authoritySync: { status: 'ready' },
        },
      ],
      sessions: { affectedCount: 3 },
      subscriptions: {
        totalCount: 0,
        activeCount: 0,
        capability: { status: 'unsupported', reason: 'Event controls are not available yet.' },
      },
    });
    vi.mocked(transport.getConnectorDisconnectImpact).mockResolvedValue({
      connectionId: 'connection-1' as never,
      affectedAgentCount: 1,
      affectedSessionCount: 3,
      affectedSubscriptionCount: 0,
      pendingDeliveryCount: 2,
    });
    const onManageAccess = vi.fn();
    renderWith(
      transport,
      <ConnectionDetailSheet
        connectionId="connection-1"
        onClose={() => undefined}
        onManageAccess={onManageAccess}
        onReconnect={() => undefined}
      />
    );

    expect(await screen.findByRole('dialog', { name: 'Gmail (work)' })).toBeInTheDocument();
    expect(
      screen.getByText('Usage is unavailable: Provider does not report usage.')
    ).toBeInTheDocument();
    expect(screen.getByText('Sync failed')).toBeInTheDocument();
    expect(
      screen.getByText('Access sync failed: Provider rejected the update.')
    ).toBeInTheDocument();
    expect(
      await screen.findByText('This service does not report any account activity yet.')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit access' }));
    expect(onManageAccess).toHaveBeenCalledWith('connection-1');

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(
      await screen.findByText(
        /1 agents, 3 sessions, and 0 subscriptions will lose access\. 2 pending deliveries will stop\./
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });
});
