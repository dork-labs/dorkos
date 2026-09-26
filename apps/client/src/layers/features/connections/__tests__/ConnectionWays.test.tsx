/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectionWays } from '../ui/ConnectionWays';

afterEach(cleanup);

function renderWays(
  transport: Transport,
  handlers = { onManageAccount: vi.fn(), onOpenConnectionsPage: vi.fn() }
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ConnectionWays {...handlers} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return handlers;
}

function provider(over: Partial<ConnectorProviderStatus> = {}): ConnectorProviderStatus {
  return {
    type: 'composio',
    configured: false,
    registered: false,
    custody: 'managed',
    disclosure: 'Composio keeps your login access in its own secure vault.',
    ...over,
  };
}

const nango = provider({
  type: 'nango',
  custody: 'self-host',
  disclosure: 'Your Nango server keeps your logins on your own machine.',
});

function connection(over: Partial<ConnectorConnectionSummary>): ConnectorConnectionSummary {
  return {
    connectionId: 'c1' as never,
    providerInstanceId: 'cpi_x' as never,
    toolkit: 'gmail',
    label: 'work',
    identityHint: null,
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'byo',
    custody: 'managed',
    payer: 'operator_byo',
    agentCount: 2,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    warnings: [],
    ...over,
  };
}

describe('ConnectionWays', () => {
  it('with nothing set up, points at the Connections page and still lets you add a key here', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectorProviders: vi.fn().mockResolvedValue([provider(), nango]),
    });
    vi.mocked(transport.putConnectorCredential).mockResolvedValue(
      provider({ configured: true, registered: true })
    );
    const handlers = renderWays(transport);

    expect(await screen.findByText('Set up when you connect your first app')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open the Connections page' }));
    expect(handlers.onOpenConnectionsPage).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Set one up here instead' }));
    const composio = screen.getByTestId('add-connection-way-composio');
    // Where sign-ins will live is said before any key is pasted.
    expect(composio).toHaveTextContent('in its own secure vault');
    await user.type(within(composio).getByLabelText('Composio API key'), '  ak_live  ');
    await user.click(within(composio).getByRole('button', { name: 'Save key' }));
    await waitFor(() =>
      expect(transport.putConnectorCredential).toHaveBeenCalledWith('composio', 'ak_live')
    );
  });

  it('shows each way that is set up with its state and how many apps use it', async () => {
    renderWays(
      createMockTransport({
        getCloudStatus: vi
          .fn()
          .mockResolvedValue({ linked: true, accountLabel: 'me', lastHeartbeatAt: null }),
        getConnectorProviders: vi
          .fn()
          .mockResolvedValue([
            provider({ configured: true, registered: true, keyKind: 'project' }),
            nango,
          ]),
        getConnectorConnections: vi.fn().mockResolvedValue({
          connections: [
            connection({ connectionId: 'm1' as never, mode: 'managed', payer: 'dorkos_managed' }),
            connection({ connectionId: 'b1' as never, toolkit: 'notion' }),
            connection({ connectionId: 'b2' as never, label: 'personal' }),
          ],
        }),
      })
    );

    const account = await screen.findByTestId('connection-way-dorkos-account');
    expect(account).toHaveTextContent('Your DorkOS account');
    expect(account).toHaveTextContent('1 app connected');
    expect(account).toHaveTextContent('Working');
    // Unlinking the account turns off more than apps, so it is never offered here.
    expect(within(account).queryByRole('button', { name: /disconnect|remove/i })).toBeNull();
    expect(within(account).getByRole('button', { name: /Manage in Access/ })).toBeInTheDocument();

    const key = screen.getByTestId('connection-way-composio');
    expect(key).toHaveTextContent('Your Composio key');
    expect(key).toHaveTextContent('2 apps connected · using your project key');
    expect(key).toHaveTextContent('Working');
    // Nango is not set up, so it is offered under "Add another way", not listed.
    expect(screen.queryByTestId('connection-way-nango')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add another way' })).toBeInTheDocument();
  });

  it('shows a refused key with the server’s reason', async () => {
    renderWays(
      createMockTransport({
        getConnectorProviders: vi.fn().mockResolvedValue([
          provider(),
          {
            ...nango,
            configured: true,
            registered: false,
            error: 'Set NANGO_ENCRYPTION_KEY before saving a Nango key.',
          },
        ]),
      })
    );
    const row = await screen.findByTestId('connection-way-nango');
    expect(row).toHaveTextContent('Not working');
    expect(within(row).getByRole('alert')).toHaveTextContent('Set NANGO_ENCRYPTION_KEY');
  });

  it('Remove… names every app that stops and the button carries the count', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectorProviders: vi
        .fn()
        .mockResolvedValue([provider({ configured: true, registered: true }), nango]),
      getConnectorConnections: vi.fn().mockResolvedValue({
        connections: [
          connection({ connectionId: 'b1' as never, toolkit: 'notion', label: 'team' }),
          connection({ connectionId: 'b2' as never, label: 'personal', agentCount: 1 }),
          connection({ connectionId: 'gone' as never, lifecycle: 'disconnected' }),
        ],
      }),
    });
    vi.mocked(transport.deleteConnectorCredential).mockResolvedValue(provider());
    renderWays(transport);

    const row = await screen.findByTestId('connection-way-composio');
    await user.click(within(row).getByRole('button', { name: 'Remove…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('These 2 apps will stop working for every agent:');
    expect(within(dialog).getByText('Notion (team)')).toBeInTheDocument();
    expect(within(dialog).getByText('Gmail (personal)')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('1 agent use it');
    expect(transport.deleteConnectorCredential).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove key and stop 2 apps' }));
    await waitFor(() =>
      expect(transport.deleteConnectorCredential).toHaveBeenCalledWith('composio')
    );
  });

  it('Change key replaces the key in place and warns what another account’s key would stop', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectorProviders: vi
        .fn()
        .mockResolvedValue([provider({ configured: true, registered: true }), nango]),
      getConnectorConnections: vi.fn().mockResolvedValue({ connections: [connection({})] }),
    });
    vi.mocked(transport.putConnectorCredential).mockResolvedValue(
      provider({ configured: true, registered: true })
    );
    renderWays(transport);

    const row = await screen.findByTestId('connection-way-composio');
    await user.click(within(row).getByRole('button', { name: 'Change key' }));
    expect(row).toHaveTextContent('A key from another account stops the 1 app connected');
    await user.type(within(row).getByLabelText('Composio API key'), 'ak_new');
    await user.click(within(row).getByRole('button', { name: 'Save key' }));
    await waitFor(() =>
      expect(transport.putConnectorCredential).toHaveBeenCalledWith('composio', 'ak_new')
    );
    await waitFor(() => expect(within(row).queryByLabelText('Composio API key')).toBeNull());
  });

  it('keeps apps whose key was removed visible, and says how to bring them back', async () => {
    renderWays(
      createMockTransport({
        getConnectorProviders: vi.fn().mockResolvedValue([provider(), nango]),
        getConnectorConnections: vi.fn().mockResolvedValue({ connections: [connection({})] }),
      })
    );
    const row = await screen.findByTestId('connection-way-composio');
    expect(row).toHaveTextContent('Key removed');
    expect(row).toHaveTextContent('Add it again to bring them back.');
    expect(within(row).getByRole('button', { name: 'Add key again' })).toBeInTheDocument();
  });

  it('sends an unlinked account to Access from the add list', async () => {
    const user = userEvent.setup();
    const handlers = renderWays(
      createMockTransport({
        getConnectorProviders: vi
          .fn()
          .mockResolvedValue([provider({ configured: true, registered: true }), nango]),
      })
    );
    await user.click(await screen.findByRole('button', { name: 'Add another way' }));
    await user.click(screen.getByRole('button', { name: /Link in Access/ }));
    expect(handlers.onManageAccount).toHaveBeenCalledTimes(1);
  });

  it('refuses to show counts it could not read', async () => {
    const user = userEvent.setup();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ connections: [] });
    renderWays(createMockTransport({ getConnectorConnections: read }));
    expect(
      await screen.findByText('Couldn’t check how DorkOS reaches your apps')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove…' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Set up when you connect your first app')).toBeInTheDocument();
  });
});
