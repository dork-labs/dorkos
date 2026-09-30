/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectorAppConnections,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { createMockTransport, createMockConnectionReadiness } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectionWays } from '../ui/ConnectionWays';

/** The providers read's answer: these statuses, and (unless given) nothing set up for new apps. */
function providersFrom(
  providers: ConnectorProviderStatus[],
  appConnections: ConnectorAppConnections = {
    ways: [],
    newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
  }
) {
  return vi.fn().mockResolvedValue({ providers, appConnections });
}

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
    providerInstanceId: 'cpi_composio' as never,
    configured: false,
    registered: false,
    custody: 'managed',
    disclosure: 'Composio keeps your login access in its own secure vault.',
    ...over,
  };
}

const nango = provider({
  type: 'nango',
  providerInstanceId: 'cpi_nango' as never,
  custody: 'self-host',
  disclosure: 'Your Nango server keeps your logins on your own machine.',
});

function connection(over: Partial<ConnectorConnectionSummary>): ConnectorConnectionSummary {
  return {
    connectionId: 'c1' as never,
    providerInstanceId: 'cpi_composio' as never,
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
    everyAgent: null,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    readiness: createMockConnectionReadiness(),
    ...over,
  };
}

describe('ConnectionWays', () => {
  it('with nothing set up, points at the Connections page and still lets you add a key here', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectorProviders: providersFrom([provider(), nango]),
    });
    vi.mocked(transport.putConnectorCredential).mockResolvedValue(
      provider({ configured: true, registered: true })
    );
    const handlers = renderWays(transport);

    expect(await screen.findByText('Set up when you connect your first app')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open the Connections page' }));
    expect(handlers.onOpenConnectionsPage).toHaveBeenCalledTimes(1);

    // Never a loop: the choices are open right here, not behind another hop.
    expect(screen.getByText('Or set one up here now:')).toBeInTheDocument();
    const composio = screen.getByTestId('add-connection-way-composio');
    // Where sign-ins will live is said before any key is pasted.
    expect(composio).toHaveTextContent('in its own secure vault');
    await user.type(within(composio).getByLabelText('Composio project key'), '  ak_live  ');
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
        getConnectorProviders: providersFrom([
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

  it('says a linked DorkOS account that can’t reach apps is not working', async () => {
    renderWays(
      createMockTransport({
        getCloudStatus: vi
          .fn()
          .mockResolvedValue({ linked: true, accountLabel: 'me', lastHeartbeatAt: null }),
        getConnectorProviders: providersFrom([], {
          ways: [{ kind: 'dorkos_account', type: 'dorkos-managed', status: 'unavailable' }],
          newApps: { status: 'setup_needed', reason: 'dorkos_account_unavailable' },
        }),
        getConnectorConnections: vi.fn().mockResolvedValue({ connections: [] }),
      })
    );
    const account = await screen.findByTestId('connection-way-dorkos-account');
    await waitFor(() => expect(account).toHaveTextContent('Can’t reach apps'));
    expect(account).not.toHaveTextContent('Working');
    expect(account).toHaveTextContent('it can’t reach apps right now');
  });

  it('says a key that signs in but can’t run actions, and how to fix it', async () => {
    const saved = provider({ configured: true, registered: true, keyKind: 'user' });
    renderWays(
      createMockTransport({
        getConnectorProviders: providersFrom([saved], {
          ways: [
            {
              kind: 'own_key',
              type: 'composio',
              status: 'ready',
              providerInstanceId: 'cpi_composio' as never,
              canRunActions: false,
              keyCanFix: true,
            },
          ],
          newApps: {
            status: 'ready',
            way: {
              kind: 'own_key',
              type: 'composio',
              status: 'ready',
              providerInstanceId: 'cpi_composio' as never,
              canRunActions: false,
              keyCanFix: true,
            },
          },
        }),
        getConnectorConnections: vi.fn().mockResolvedValue({ connections: [] }),
      })
    );
    const key = await screen.findByTestId('connection-way-composio');
    await waitFor(() => expect(key).toHaveTextContent('Can’t run actions'));
    expect(key).toHaveTextContent('Change it to a project key');
    expect(key).not.toHaveTextContent('Working');
  });

  it('marks the way new apps use, only when there is more than one way', async () => {
    const composioReady = { kind: 'own_key' as const, type: 'composio', status: 'ready' as const };
    renderWays(
      createMockTransport({
        getCloudStatus: vi
          .fn()
          .mockResolvedValue({ linked: true, accountLabel: 'me', lastHeartbeatAt: null }),
        getConnectorProviders: providersFrom(
          [provider({ configured: true, registered: true }), nango],
          {
            ways: [
              { kind: 'dorkos_account', type: 'dorkos-managed', status: 'ready' },
              composioReady,
            ],
            newApps: { status: 'ready', way: composioReady },
          }
        ),
      })
    );

    const key = await screen.findByTestId('connection-way-composio');
    await waitFor(() => expect(within(key).getByText('Used for new apps')).toBeInTheDocument());
    const account = screen.getByTestId('connection-way-dorkos-account');
    expect(within(account).queryByText('Used for new apps')).toBeNull();
  });

  it('leaves the marker off when only one way is set up', async () => {
    const composioReady = { kind: 'own_key' as const, type: 'composio', status: 'ready' as const };
    renderWays(
      createMockTransport({
        getConnectorProviders: providersFrom(
          [provider({ configured: true, registered: true }), nango],
          { ways: [composioReady], newApps: { status: 'ready', way: composioReady } }
        ),
      })
    );

    await screen.findByTestId('connection-way-composio');
    expect(screen.queryByText('Used for new apps')).toBeNull();
  });

  it('shows a refused key with the server’s reason', async () => {
    renderWays(
      createMockTransport({
        getConnectorProviders: providersFrom([
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
      getConnectorProviders: providersFrom([
        provider({ configured: true, registered: true }),
        nango,
      ]),
      getConnectorConnections: vi.fn().mockResolvedValue({
        connections: [
          connection({ connectionId: 'b1' as never, toolkit: 'notion', label: 'team' }),
          connection({ connectionId: 'b2' as never, label: 'personal', agentCount: 1 }),
          connection({
            connectionId: 'p1' as never,
            toolkit: 'linear',
            lifecycle: 'paused',
            readiness: createMockConnectionReadiness({
              state: 'paused',
              reason: 'paused',
              fix: { action: 'resume', fixableBy: 'person' },
            }),
          }),
          connection({
            connectionId: 'gone' as never,
            lifecycle: 'disconnected',
            readiness: createMockConnectionReadiness({ state: 'gone', reason: 'disconnected' }),
          }),
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
    expect(dialog).toHaveTextContent('Gmail (personal) · used by 1 agent');
    expect(dialog).toHaveTextContent('Notion (team) · used by 2 agents');
    // A paused app is listed honestly and not counted as a loss.
    expect(dialog).toHaveTextContent('This app can’t be used now either way:');
    expect(within(dialog).getByText('Linear (work)')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('Gmail (work)');
    expect(transport.deleteConnectorCredential).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove key and stop 2 apps' }));
    await waitFor(() =>
      expect(transport.deleteConnectorCredential).toHaveBeenCalledWith('composio')
    );
  });

  it('Change key asks first, names the apps it pauses, then saves over the old key', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectorProviders: providersFrom([
        provider({ configured: true, registered: true }),
        nango,
      ]),
      getConnectorConnections: vi.fn().mockResolvedValue({
        connections: [
          connection({}),
          connection({ connectionId: 'c2' as never, toolkit: 'notion', label: 'team' }),
        ],
      }),
    });
    vi.mocked(transport.putConnectorCredential).mockResolvedValue(
      provider({ configured: true, registered: true })
    );
    renderWays(transport);

    const row = await screen.findByTestId('connection-way-composio');
    await user.click(within(row).getByRole('button', { name: 'Change key' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('A new key pauses the apps on this one until you review');
    expect(dialog).toHaveTextContent('different Composio project can’t reach them at all');
    expect(dialog).toHaveTextContent(
      'These 2 apps pause until you review their access on the Connections page:'
    );
    expect(within(dialog).getByText('Gmail (work)')).toBeInTheDocument();
    expect(within(dialog).getByText('Notion (team)')).toBeInTheDocument();
    // No form until the person agrees.
    expect(within(row).queryByLabelText('Composio project key')).toBeNull();
    expect(dialog).toHaveTextContent('Nothing changes until you save the new key.');
    await user.click(within(dialog).getByRole('button', { name: 'Continue to a new key' }));

    // Continuing only opens the form: nothing is saved or paused yet.
    const input = await within(row).findByLabelText('Composio project key');
    expect(transport.putConnectorCredential).not.toHaveBeenCalled();
    await user.type(input, 'ak_new');
    await user.click(within(row).getByRole('button', { name: 'Save key' }));
    await waitFor(() =>
      expect(transport.putConnectorCredential).toHaveBeenCalledWith('composio', 'ak_new')
    );
    await waitFor(() => expect(within(row).queryByLabelText('Composio project key')).toBeNull());
  });

  it('Change key backs out cleanly: keeping the key saves nothing', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectorProviders: providersFrom([
        provider({ configured: true, registered: true }),
        nango,
      ]),
      getConnectorConnections: vi.fn().mockResolvedValue({ connections: [connection({})] }),
    });
    renderWays(transport);
    const row = await screen.findByTestId('connection-way-composio');
    await user.click(within(row).getByRole('button', { name: 'Change key' }));
    await user.click(await screen.findByRole('button', { name: 'Keep this key' }));
    expect(within(row).queryByLabelText('Composio project key')).toBeNull();
    expect(transport.putConnectorCredential).not.toHaveBeenCalled();
  });

  it('Change key with no apps on the key goes straight to the form', async () => {
    const user = userEvent.setup();
    renderWays(
      createMockTransport({
        getConnectorProviders: providersFrom([
          provider({ configured: true, registered: true }),
          nango,
        ]),
      })
    );
    const row = await screen.findByTestId('connection-way-composio');
    await user.click(within(row).getByRole('button', { name: 'Change key' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(within(row).getByLabelText('Composio project key')).toBeInTheDocument();
  });

  it('on a refused key, counts nothing as stopping: the apps already can’t be used', async () => {
    const user = userEvent.setup();
    renderWays(
      createMockTransport({
        getConnectorProviders: providersFrom([
          provider({ configured: true, registered: false, error: 'Invalid API key' }),
          nango,
        ]),
        // The server already reads the key's apps as cut off.
        getConnectorConnections: vi.fn().mockResolvedValue({
          connections: [
            connection({
              readiness: createMockConnectionReadiness({
                state: 'needs_you',
                reason: 'own_key_unavailable',
                fix: { action: 'fix_key', fixableBy: 'person' },
              }),
            }),
          ],
        }),
      })
    );
    const row = await screen.findByTestId('connection-way-composio');
    await user.click(within(row).getByRole('button', { name: 'Remove…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('This app can’t be used now either way:');
    expect(dialog).not.toHaveTextContent('will stop working');
    expect(within(dialog).getByRole('button', { name: 'Remove key' })).toBeInTheDocument();
  });

  it('groups apps by the exact key instance, not by kind', async () => {
    renderWays(
      createMockTransport({
        getConnectorProviders: providersFrom([
          provider({ configured: true, registered: true }),
          // A second key of the same kind and custody (test mode's scripted one).
          provider({
            type: 'test-connector',
            providerInstanceId: 'cpi_test' as never,
            configured: true,
            registered: true,
          }),
          nango,
        ]),
        getConnectorConnections: vi.fn().mockResolvedValue({
          connections: [
            connection({ connectionId: 'a' as never }),
            connection({ connectionId: 'b' as never, providerInstanceId: 'cpi_test' as never }),
            connection({ connectionId: 'c' as never, providerInstanceId: 'cpi_test' as never }),
            // A raw server nobody sets up here belongs to no row.
            connection({ connectionId: 'raw' as never, providerInstanceId: 'cpi_raw' as never }),
          ],
        }),
      })
    );
    expect(await screen.findByTestId('connection-way-composio')).toHaveTextContent(
      '1 app connected'
    );
    expect(screen.getByTestId('connection-way-test-connector')).toHaveTextContent(
      '2 apps connected'
    );
  });

  it('keeps apps whose key was removed visible, and says how to bring them back', async () => {
    renderWays(
      createMockTransport({
        getConnectorProviders: providersFrom([provider(), nango]),
        getConnectorConnections: vi.fn().mockResolvedValue({ connections: [connection({})] }),
      })
    );
    const row = await screen.findByTestId('connection-way-composio');
    expect(row).toHaveTextContent('Key removed');
    expect(row).toHaveTextContent('Add the same key again to bring them back.');
    expect(within(row).getByRole('button', { name: 'Add key again' })).toBeInTheDocument();
  });

  it('says linking again with the same account can bring back apps an unlinked account kept (DOR-2521)', async () => {
    renderWays(
      createMockTransport({
        getCloudStatus: vi
          .fn()
          .mockResolvedValue({ linked: false, accountLabel: null, lastHeartbeatAt: null }),
        getConnectorProviders: providersFrom([provider(), nango]),
        getConnectorConnections: vi.fn().mockResolvedValue({
          connections: [
            connection({ connectionId: 'm1' as never, mode: 'managed', payer: 'dorkos_managed' }),
          ],
        }),
      })
    );
    const account = await screen.findByTestId('connection-way-dorkos-account');
    expect(account).toHaveTextContent('Not linked');
    // Conditional, never a promise: a different account, or an earlier link
    // removed from the account, brings nothing back.
    expect(account).toHaveTextContent(
      'Linking this computer again with the same DorkOS account can bring them back, unless its earlier link was removed from that account. Otherwise, connect them again through a way that works.'
    );
  });

  it('sends an unlinked account to Access from the add list', async () => {
    const user = userEvent.setup();
    const handlers = renderWays(
      createMockTransport({
        getConnectorProviders: providersFrom([
          provider({ configured: true, registered: true }),
          nango,
        ]),
      })
    );
    await user.click(await screen.findByRole('button', { name: 'Add another way' }));
    await user.click(screen.getByRole('button', { name: /Link in Access/ }));
    expect(handlers.onManageAccount).toHaveBeenCalledTimes(1);
  });

  it('never claims nothing is set up when the account check failed, and retries it', async () => {
    const user = userEvent.setup();
    const cloudRead = vi
      .fn()
      .mockRejectedValueOnce(new Error('cloud down'))
      .mockResolvedValue({ linked: true, accountLabel: 'me', lastHeartbeatAt: null });
    renderWays(
      createMockTransport({
        getCloudStatus: cloudRead,
        getConnectorProviders: providersFrom([provider(), nango]),
      })
    );

    const account = await screen.findByTestId('connection-way-dorkos-account');
    expect(account).toHaveTextContent('Couldn’t check your DorkOS account');
    expect(screen.queryByText('Set up when you connect your first app')).toBeNull();
    await user.click(within(account).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(account).toHaveTextContent('Working'));
    expect(cloudRead).toHaveBeenCalledTimes(2);
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
