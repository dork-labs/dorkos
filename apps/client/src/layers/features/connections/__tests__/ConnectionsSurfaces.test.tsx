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
import { setPlatformAdapter } from '@/layers/shared/lib';
import { AccountsList } from '../ui/AccountsList';
import { ConnectionDetailSheet } from '../ui/ConnectionDetailSheet';
import { ServiceGrid } from '../ui/ServiceGrid';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
afterEach(() => {
  cleanup();
  setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
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
    renderWith(transport, <ServiceGrid onConnect={onConnect} />);
    await user.click(screen.getByRole('button', { name: 'Connect service' }));
    await user.type(screen.getByRole('textbox', { name: 'Search services' }), 'Slack');
    expect(
      await screen.findByRole('button', { name: 'Messages through a Slack bot' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use a Slack account' }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ serviceSlug: 'slack' }));
    expect(transport.getConnectorCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Slack', limit: 24 })
    );
  });
});

describe('AccountsList', () => {
  it('explains embedded unavailability without claiming there are no accounts', async () => {
    setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
    const transport = createMockTransport({
      getConnectorConnections: vi
        .fn()
        .mockRejectedValue(new Error('Connections can only be managed in DorkOS itself.')),
    });

    renderWith(transport, <AccountsList onOpenDetail={() => undefined} />);

    expect(await screen.findByText('Connected accounts are unavailable here')).toBeInTheDocument();
    expect(screen.getByText(/Open DorkOS in your browser to connect services/)).toBeInTheDocument();
    expect(screen.queryByText('No accounts connected')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

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
    expect(screen.getByText(/Event subscriptions are unavailable/)).toBeInTheDocument();
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
