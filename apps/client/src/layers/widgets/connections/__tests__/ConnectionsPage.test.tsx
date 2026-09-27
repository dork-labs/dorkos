/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { connectorKeys } from '@/layers/entities/connectors';
import { ConnectionsPage } from '../ui/ConnectionsPage';

/** The page's URL state, as the router would hand it over. */
const route = vi.hoisted(() => ({ search: {} as Record<string, string | undefined> }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useSearch: () => route.search,
  useNavigate: () => navigate,
}));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useEventSubscription: () => {},
  useEventStream: () => ({ connectionState: 'connected', failedAttempts: 0 }),
  useSettingsDeepLink: () => ({ open: vi.fn() }),
  useSafeNavigate: () => navigate,
}));

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

/** The search the last navigation would leave in the address. */
function nextSearch(): Record<string, unknown> {
  const call = navigate.mock.calls.at(-1)?.[0] as {
    search: (previous: Record<string, unknown>) => Record<string, unknown>;
  };
  return call.search(route.search);
}

function summary(over: Partial<ConnectorConnectionSummary> = {}): ConnectorConnectionSummary {
  return {
    connectionId: 'c-notion' as never,
    providerInstanceId: 'provider-1' as never,
    toolkit: 'notion',
    label: 'Acme',
    identityHint: null,
    lifecycle: 'connected',
    authenticationStatus: 'expired',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'byo',
    custody: 'external',
    payer: 'operator_byo',
    agentCount: 1,
    everyAgent: null,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    warnings: [],
    ...over,
  };
}

function transportWith(connections: ConnectorConnectionSummary[]): Transport {
  return createMockTransport({
    getConnectorConnections: vi.fn().mockResolvedValue({ connections }),
    getConfig: vi.fn().mockResolvedValue({ relay: { enabled: false } }),
    // The access card's read is covered by its own tests; here it just fails quietly.
    previewConnectorReconciliation: vi.fn().mockRejectedValue(new Error('not in this test')),
  });
}

function renderPage(transport: Transport, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  seed?.(client);
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ConnectionsPage />
      </TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  navigate.mockReset();
  route.search = {};
});
afterEach(cleanup);

describe('ConnectionsPage', () => {
  it('floats a signed-out app to the top and starts its sign-in from the row', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      summary({
        connectionId: 'c-gmail' as never,
        toolkit: 'gmail',
        authenticationStatus: 'active',
      }),
      summary(),
    ]);
    vi.mocked(transport.reconnectConnectorConnection).mockResolvedValue({
      flowId: 'flow-1',
    } as never);
    renderPage(transport);

    const rows = await screen.findAllByTestId(/^app-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', 'app-row-c-notion');
    await user.click(within(rows[0]).getByRole('button', { name: 'Sign in again: Notion' }));

    await waitFor(() =>
      expect(transport.reconnectConnectorConnection).toHaveBeenCalledWith('c-notion', {
        idempotencyKey: expect.any(String),
      })
    );
    await waitFor(() => expect(nextSearch()).toMatchObject({ flow: 'flow-1' }));
  });

  it('opens the side panel a link names, as a dialog with the app’s name', async () => {
    route.search = { app: 'c-notion' };
    const transport = transportWith([summary()]);
    vi.mocked(transport.getConnectorConnection).mockResolvedValue({
      connection: summary(),
      provider: {
        providerInstanceId: 'provider-1' as never,
        displayName: 'Nango',
        mode: 'byo',
        custody: 'self-host',
        payer: 'operator_byo',
        capabilities: {
          catalog: { status: 'available' },
          authentication: { status: 'available' },
          accounts: { status: 'available' },
          operations: { status: 'available' },
          execution: { status: 'available' },
          triggers: { status: 'unsupported', reason: 'No.' },
        },
        disclosure: 'Your Nango server keeps this sign-in.',
      },
      agents: [],
      sessions: { affectedCount: 0 },
      subscriptions: {
        totalCount: 0,
        activeCount: 0,
        capability: { status: 'unsupported', reason: 'No.' },
      },
    });
    renderPage(transport);

    const panel = await screen.findByRole('dialog', { name: /Notion/ });
    expect(await within(panel).findByTestId('app-panel-fix')).toHaveTextContent(
      'Signed out. Agents can’t use Notion.'
    );
  });

  it('closes a link to an app that is gone instead of holding an empty panel', async () => {
    route.search = { app: 'c-removed' };
    renderPage(transportWith([summary()]));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(nextSearch()).not.toHaveProperty('app');
  });

  it('waits for a refresh before closing a panel whose app it has not seen yet', async () => {
    // Finishing a connect opens the new app's panel while the list is still
    // being re-read; the panel must survive that read rather than close.
    route.search = { app: 'c-new' };
    let finish!: (value: { connections: ConnectorConnectionSummary[] }) => void;
    const transport = transportWith([]);
    vi.mocked(transport.getConnectorConnections).mockImplementation(
      () => new Promise((resolve) => (finish = resolve))
    );
    vi.mocked(transport.getConnectorConnection).mockReturnValue(new Promise(() => {}));
    renderPage(transport, (client) =>
      client.setQueryData(connectorKeys.connections(), { connections: [] })
    );

    await waitFor(() => expect(transport.getConnectorConnections).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    finish({ connections: [summary({ connectionId: 'c-new' as never })] });

    expect(await screen.findByRole('dialog', { name: /Notion/ })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
