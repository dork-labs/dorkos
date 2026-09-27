/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConnectorConnectionDetail,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorUsageItem } from '@dorkos/shared/connector-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AccountPanel } from '../ui/panel/AccountPanel';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeNavigate: () => navigate,
}));

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

beforeEach(() => navigate.mockReset());
afterEach(cleanup);

function summary(over: Partial<ConnectorConnectionSummary> = {}): ConnectorConnectionSummary {
  return {
    connectionId: 'c-1' as never,
    providerInstanceId: 'provider-1' as never,
    toolkit: 'gmail',
    label: 'personal',
    identityHint: 'you@gmail.com',
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'managed',
    custody: 'managed',
    payer: 'dorkos_managed',
    agentCount: 1,
    everyAgent: null,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 4, attemptCount: 4 },
    warnings: [],
    ...over,
  };
}

function detail(connection: ConnectorConnectionSummary): ConnectorConnectionDetail {
  return {
    connection,
    provider: {
      providerInstanceId: 'provider-1' as never,
      displayName: 'Composio',
      mode: 'managed',
      custody: 'managed',
      payer: 'dorkos_managed',
      capabilities: {
        catalog: { status: 'available' },
        authentication: { status: 'available' },
        accounts: { status: 'available' },
        operations: { status: 'available' },
        execution: { status: 'available' },
        triggers: { status: 'unsupported', reason: 'No.' },
      },
      disclosure: 'Composio keeps your login access in its own secure vault.',
    },
    agents: [
      {
        agentId: 'mailroom',
        displayName: 'mailroom',
        operationRevisionIds: ['list-v1'],
        classifications: ['read'],
        reconciliationStatus: 'ready',
        authoritySync: { status: 'ready' },
      },
    ],
    sessions: { affectedCount: 0 },
    subscriptions: {
      totalCount: 0,
      activeCount: 0,
      capability: { status: 'unsupported', reason: 'No.' },
    },
  };
}

function usage(index: number, operationSlug: string): ConnectorUsageItem {
  return {
    logicalOperationId: `op-${index}`,
    attemptIndex: 1,
    surface: 'mcp',
    actorKind: 'agent',
    agentId: 'mailroom',
    connectionId: 'c-1' as never,
    toolkit: 'gmail',
    operationRevisionId: `${operationSlug}-v1`,
    operationSlug,
    payer: 'dorkos_managed',
    outcome: 'success',
    startedAt: new Date(Date.now() - index * 60_000).toISOString(),
    completedAt: new Date(Date.now() - index * 60_000).toISOString(),
  };
}

function transportFor(connection: ConnectorConnectionSummary): Transport {
  return createMockTransport({
    getConnectorConnection: vi.fn().mockResolvedValue(detail(connection)),
    getOperatorConnectorUsage: vi.fn().mockResolvedValue({
      items: [
        usage(1, 'GMAIL_FETCH_EMAILS'),
        usage(2, 'GMAIL_SEND_EMAIL'),
        usage(3, 'GMAIL_FETCH_EMAILS'),
        usage(4, 'GMAIL_CREATE_EMAIL_DRAFT'),
      ],
    }),
    listMeshAgents: vi.fn().mockResolvedValue({
      agents: [
        { id: 'dorkbot', name: 'DorkBot', isSystem: true },
        { id: 'mailroom', name: 'mailroom' },
      ],
    }),
    listMeshAgentPaths: vi.fn().mockResolvedValue({
      agents: [
        { id: 'dorkbot', name: 'DorkBot', projectPath: '/agents/dorkbot' },
        { id: 'mailroom', name: 'mailroom', projectPath: '/agents/mailroom' },
      ],
    }),
    previewConnectorReconciliation: vi.fn().mockRejectedValue(new Error('not in this test')),
  });
}

function renderPanel(transport: Transport) {
  const handlers = {
    onSignInStarted: vi.fn(),
    onEditExactActions: vi.fn(),
    onAddAnother: vi.fn(),
    onClose: vi.fn(),
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <AccountPanel connectionId="c-1" {...handlers} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return Object.assign(handlers, { client });
}

describe('AccountPanel', () => {
  it('shows three plain lines of what agents did, then all of them on "See all"', async () => {
    const user = userEvent.setup();
    renderPanel(transportFor(summary()));

    const recently = await screen.findByRole('region', { name: 'Recently' });
    await waitFor(() => expect(within(recently).getAllByText(/^mailroom · /)).toHaveLength(3));
    expect(within(recently).getByText('mailroom · Send email')).toBeInTheDocument();
    await user.click(within(recently).getByRole('button', { name: 'See all' }));
    expect(within(recently).getAllByText(/^mailroom · /)).toHaveLength(4);
  });

  it('opens a chat with the first agent that has access, the prompt typed and not sent', async () => {
    const user = userEvent.setup();
    renderPanel(transportFor(summary()));

    const tryIt = await screen.findByRole('region', { name: 'Try it' });
    await waitFor(() => expect(tryIt).toHaveTextContent('Opens a chat with mailroom'));
    await user.click(within(tryIt).getByRole('button', { name: /Summarise today’s Gmail inbox/ }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/session',
        search: expect.objectContaining({
          dir: '/agents/mailroom',
          prompt: 'Summarise today’s Gmail inbox',
        }),
      })
    );
    const [{ search }] = navigate.mock.calls[0] as [{ search: Record<string, unknown> }];
    expect(search.send).toBeUndefined();
  });

  it('puts the one fix on top of a signed-out account and starts its sign-in', async () => {
    const user = userEvent.setup();
    const transport = transportFor(summary({ authenticationStatus: 'expired' }));
    vi.mocked(transport.reconnectConnectorConnection).mockResolvedValue({
      flowId: 'flow-9',
    } as never);
    const handlers = renderPanel(transport);

    const fix = await screen.findByTestId('app-panel-fix');
    expect(fix).toHaveTextContent('Signed out. Agents can’t use Gmail.');
    await user.click(within(fix).getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(handlers.onSignInStarted).toHaveBeenCalledWith('flow-9'));
    // A signed-out account offers nothing to try.
    expect(screen.queryByRole('region', { name: 'Try it' })).not.toBeInTheDocument();
  });

  it.each(['pending', 'unknown', 'failed'] as const)(
    'keeps reconnect and removal closed while disconnecting is %s, and offers to finish',
    async (externalCleanup) => {
      renderPanel(transportFor(summary({ lifecycle: 'disconnected', externalCleanup })));
      const fix = await screen.findByTestId('app-panel-fix');
      expect(
        within(fix).getByRole('button', {
          name: externalCleanup === 'failed' ? 'Try disconnecting again' : 'Finish disconnecting',
        })
      ).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Connect again' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('remove-account')).not.toBeInTheDocument();
    }
  );

  it('says why a stalled sign-out is waiting and when it tries again', async () => {
    const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
    renderPanel(
      transportFor(
        summary({
          lifecycle: 'disconnected',
          externalCleanup: 'pending',
          authoritySync: { status: 'pending', reason: 'DorkOS’s servers had a problem.', retryAt },
        })
      )
    );
    const fix = await screen.findByTestId('app-panel-fix');
    expect(fix).toHaveTextContent('Disconnecting didn’t finish. Agents already can’t use Gmail.');
    expect(fix).toHaveTextContent(/DorkOS’s servers had a problem\. Trying again at .+\./);
  });

  it('says it is still finishing after "Finish disconnecting", and keeps the button usable', async () => {
    const user = userEvent.setup();
    const transport = transportFor(
      summary({ lifecycle: 'disconnected', externalCleanup: 'pending' })
    );
    vi.mocked(transport.disconnectConnectorConnection).mockResolvedValue({
      connectionId: 'c-1' as never,
      lifecycle: 'disconnected',
      authenticationStatus: 'active',
      authoritySync: { status: 'pending' },
      externalCleanup: 'pending',
    });
    renderPanel(transport);

    const fix = await screen.findByTestId('app-panel-fix');
    await user.click(within(fix).getByRole('button', { name: 'Finish disconnecting' }));
    await waitFor(() =>
      expect(fix).toHaveTextContent(
        'Still finishing disconnecting Gmail. Agents already can’t use it.'
      )
    );
    expect(fix).toHaveTextContent('DorkOS keeps trying on its own.');
    const again = within(fix).getByRole('button', { name: 'Try again now' });
    expect(again).toBeEnabled();
    await user.click(again);
    await waitFor(() => expect(transport.disconnectConnectorConnection).toHaveBeenCalledTimes(2));
  });

  it('shows a refused sign-out as refused, with its reason, and never says it keeps trying', async () => {
    renderPanel(
      transportFor(
        summary({
          lifecycle: 'disconnected',
          externalCleanup: 'pending',
          authoritySync: { status: 'failed', reason: 'This instance is no longer linked.' },
        })
      )
    );
    const fix = await screen.findByTestId('app-panel-fix');
    expect(fix).toHaveTextContent('Disconnecting didn’t finish. Agents already can’t use Gmail.');
    expect(fix).toHaveTextContent('This instance is no longer linked.');
    expect(fix).not.toHaveTextContent(/keeps trying|Still finishing|Trying again/);
    expect(within(fix).getByRole('button', { name: 'Try disconnecting again' })).toBeEnabled();
  });

  it('believes a refusal from "Finish disconnecting" even when nothing was stored', async () => {
    const user = userEvent.setup();
    const transport = transportFor(
      summary({ lifecycle: 'disconnected', externalCleanup: 'pending' })
    );
    vi.mocked(transport.disconnectConnectorConnection).mockResolvedValue({
      connectionId: 'c-1' as never,
      lifecycle: 'disconnected',
      authenticationStatus: 'active',
      authoritySync: {
        status: 'failed',
        reason: 'Link this installation before finishing account disconnection.',
      },
      externalCleanup: 'pending',
    });
    renderPanel(transport);

    const fix = await screen.findByTestId('app-panel-fix');
    await user.click(within(fix).getByRole('button', { name: 'Finish disconnecting' }));
    await waitFor(() =>
      expect(fix).toHaveTextContent(
        'Link this installation before finishing account disconnection.'
      )
    );
    expect(fix).not.toHaveTextContent(/keeps trying|Still finishing/);
    expect(within(fix).getByRole('button', { name: 'Try disconnecting again' })).toBeEnabled();
  });

  it('lets the stored state take over once it moves on after a refused try', async () => {
    const user = userEvent.setup();
    const transport = transportFor(
      summary({ lifecycle: 'disconnected', externalCleanup: 'pending' })
    );
    vi.mocked(transport.disconnectConnectorConnection).mockResolvedValue({
      connectionId: 'c-1' as never,
      lifecycle: 'disconnected',
      authenticationStatus: 'active',
      authoritySync: {
        status: 'failed',
        reason: 'Link this installation before finishing account disconnection.',
      },
      externalCleanup: 'pending',
    });
    const { client } = renderPanel(transport);
    const fix = await screen.findByTestId('app-panel-fix');
    await user.click(within(fix).getByRole('button', { name: 'Finish disconnecting' }));
    await waitFor(() => expect(fix).toHaveTextContent('Link this installation'));

    // Relinked elsewhere: DorkOS is retrying again, and says so.
    const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
    vi.mocked(transport.getConnectorConnection).mockResolvedValue(
      detail(
        summary({
          lifecycle: 'disconnected',
          externalCleanup: 'pending',
          authoritySync: { status: 'pending', reason: 'DorkOS’s servers had a problem.', retryAt },
        })
      )
    );
    await client.invalidateQueries();
    await waitFor(() => expect(fix).toHaveTextContent('DorkOS’s servers had a problem.'));
    expect(fix).not.toHaveTextContent('Link this installation');
    expect(fix).toHaveTextContent('Still finishing disconnecting Gmail.');
  });

  it('asks before disconnecting, naming who loses access, then closes', async () => {
    const user = userEvent.setup();
    const transport = transportFor(summary());
    vi.mocked(transport.getConnectorDisconnectImpact).mockResolvedValue({
      connectionId: 'c-1' as never,
      affectedAgentCount: 1,
      everyAgent: false,
      affectedSessionCount: 0,
      affectedSubscriptionCount: 0,
      pendingDeliveryCount: 0,
    });
    vi.mocked(transport.disconnectConnectorConnection).mockResolvedValue({} as never);
    const handlers = renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: 'More' }));
    const more = screen.getByTestId('app-panel-more');
    expect(more).toHaveTextContent('Through Composio.');
    await user.click(within(more).getByRole('button', { name: /Disconnect…/ }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Disconnect Gmail?' });
    expect(await within(confirm).findByText('mailroom will lose access.')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
  });

  it('stops sharing with every agent from More, and says every agent loses access on disconnect', async () => {
    const user = userEvent.setup();
    const transport = transportFor(
      summary({
        agentCount: 0,
        everyAgent: { operationRevisionIds: ['op-1', 'op-2'], classifications: ['read', 'write'] },
      })
    );
    vi.mocked(transport.stopSharingConnectorWithEveryAgent).mockResolvedValue({
      connectionId: 'c-1' as never,
      revokedCount: 2,
    });
    vi.mocked(transport.getConnectorDisconnectImpact).mockResolvedValue({
      connectionId: 'c-1' as never,
      affectedAgentCount: 0,
      everyAgent: true,
      affectedSessionCount: 0,
      affectedSubscriptionCount: 0,
      pendingDeliveryCount: 0,
    });
    renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: 'More' }));
    const more = screen.getByTestId('app-panel-more');
    await user.click(within(more).getByRole('button', { name: /Stop sharing with every agent/ }));
    await waitFor(() =>
      expect(transport.stopSharingConnectorWithEveryAgent).toHaveBeenCalledWith('c-1')
    );

    await user.click(within(more).getByRole('button', { name: /Disconnect…/ }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Disconnect Gmail?' });
    expect(await within(confirm).findByText('Every agent will lose access.')).toBeInTheDocument();
  });

  it('asks before removing a disconnected app from the list', async () => {
    const user = userEvent.setup();
    const transport = transportFor(
      summary({ lifecycle: 'disconnected', externalCleanup: 'complete' })
    );
    vi.mocked(transport.removeConnectorConnection).mockResolvedValue(undefined as never);
    const handlers = renderPanel(transport);

    await user.click(await screen.findByTestId('remove-account'));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove Gmail from your apps?',
    });
    expect(transport.removeConnectorConnection).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
  });

  it('asks for a review whenever the server says access needs one, even when only every agent holds it', async () => {
    const user = userEvent.setup();
    const handlers = renderPanel(
      transportFor(
        summary({
          agentCount: 0,
          reconciliationStatus: 'migration_needs_reconcile',
          everyAgent: { operationRevisionIds: ['op-1'], classifications: ['read'] },
        })
      )
    );
    const fix = await screen.findByTestId('app-panel-fix');
    await user.click(within(fix).getByRole('button', { name: 'Review' }));
    expect(handlers.onEditExactActions).toHaveBeenCalledWith('c-1');
  });

  it('says a sign-in that never finished the way its row does', async () => {
    renderPanel(transportFor(summary({ authenticationStatus: 'pending' })));
    expect(await screen.findByTestId('app-panel-fix')).toHaveTextContent(
      'Sign-in didn’t finish. Agents can’t use Gmail yet.'
    );
  });

  it('keeps Sign in again and who pays for usage under More on a healthy account', async () => {
    const user = userEvent.setup();
    const transport = transportFor(summary());
    vi.mocked(transport.reconnectConnectorConnection).mockResolvedValue({
      flowId: 'flow-2',
    } as never);
    const handlers = renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: 'More' }));
    const more = screen.getByTestId('app-panel-more');
    expect(more).toHaveTextContent('DorkOS covers service usage.');
    await user.click(within(more).getByRole('button', { name: /^Sign in again/ }));
    await waitFor(() => expect(handlers.onSignInStarted).toHaveBeenCalledWith('flow-2'));
  });

  it('asks for a review when the server says so even with nobody holding access', async () => {
    const transport = transportFor(
      summary({ agentCount: 0, reconciliationStatus: 'migration_needs_reconcile' })
    );
    vi.mocked(transport.getConnectorConnection).mockResolvedValue({
      ...detail(summary({ agentCount: 0, reconciliationStatus: 'migration_needs_reconcile' })),
      agents: [],
    });
    renderPanel(transport);
    const fix = await screen.findByTestId('app-panel-fix');
    expect(within(fix).getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });
});
