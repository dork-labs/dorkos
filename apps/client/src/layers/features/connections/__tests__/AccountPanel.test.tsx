/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConnectorConnectionDetail,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import type {
  ConnectionFixAction,
  ConnectionReadinessReason,
  ConnectionReadinessState,
  ConnectorUsageItem,
} from '@dorkos/shared/connector-schemas';
import { CONNECTION_READINESS_COPY } from '@dorkos/shared/connector-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport, createMockConnectionReadiness } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AccountPanel } from '../ui/panel/AccountPanel';

const navigate = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeNavigate: () => navigate,
  useSettingsDeepLink: () => ({ open: openSettings }),
}));

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

beforeEach(() => {
  navigate.mockReset();
  openSettings.mockReset();
});

/** The server's readiness for an account that is not ready. */
function notReady(
  state: ConnectionReadinessState,
  reason: ConnectionReadinessReason,
  owner: string,
  fix?: { action: ConnectionFixAction; fixableBy: 'person' | 'dorkos'; retryAt?: string }
) {
  return createMockConnectionReadiness({
    state,
    reason,
    ...(fix && { fix }),
    copy: { owner, agent: 'Agent line.' },
  });
}
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
    readiness: createMockConnectionReadiness(),
    ...over,
  };
}

function detail(connection: ConnectorConnectionSummary): ConnectorConnectionDetail {
  return {
    connection,
    provider: {
      providerInstanceId: 'provider-1' as never,
      displayName: 'Your DorkOS account',
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
    const transport = transportFor(
      summary({
        authenticationStatus: 'expired',
        readiness: notReady('needs_you', 'signed_out', 'Signed out. Agents can’t use it.', {
          action: 'sign_in_again',
          fixableBy: 'person',
        }),
      })
    );
    vi.mocked(transport.reconnectConnectorConnection).mockResolvedValue({
      flowId: 'flow-9',
    } as never);
    const handlers = renderPanel(transport);

    const fix = await screen.findByTestId('app-panel-fix');
    expect(fix).toHaveTextContent('Signed out. Agents can’t use it.');
    await user.click(within(fix).getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(handlers.onSignInStarted).toHaveBeenCalledWith('flow-9'));
    // A signed-out account offers nothing to try.
    expect(screen.queryByRole('region', { name: 'Try it' })).not.toBeInTheDocument();
  });

  it('shows nothing to fix on a ready account', async () => {
    renderPanel(transportFor(summary()));
    await screen.findByRole('region', { name: 'Try it' });
    expect(screen.queryByTestId('app-panel-fix')).not.toBeInTheDocument();
  });

  it('resumes a paused account from its fix', async () => {
    const user = userEvent.setup();
    const transport = transportFor(
      summary({
        lifecycle: 'paused',
        readiness: notReady('paused', 'paused', 'Paused.', {
          action: 'resume',
          fixableBy: 'person',
        }),
      })
    );
    renderPanel(transport);
    const fix = await screen.findByTestId('app-panel-fix');
    await user.click(within(fix).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(transport.resumeConnectorConnection).toHaveBeenCalledWith('c-1'));
  });

  it('opens who can use it for a review', async () => {
    const user = userEvent.setup();
    const handlers = renderPanel(
      transportFor(
        summary({
          readiness: notReady('needs_you', 'needs_review', 'Check who can use it.', {
            action: 'review_access',
            fixableBy: 'person',
          }),
        })
      )
    );
    const fix = await screen.findByTestId('app-panel-fix');
    await user.click(within(fix).getByRole('button', { name: 'Check who can use it' }));
    expect(handlers.onEditExactActions).toHaveBeenCalledWith('c-1');
  });

  it('sends a key problem to Settings › Connections', async () => {
    const user = userEvent.setup();
    renderPanel(
      transportFor(
        summary({
          readiness: notReady('needs_you', 'own_key_unavailable', 'Fix the key to use it.', {
            action: 'fix_key',
            fixableBy: 'person',
          }),
        })
      )
    );
    const fix = await screen.findByTestId('app-panel-fix');
    await user.click(within(fix).getByRole('button', { name: 'Fix the key' }));
    expect(openSettings).toHaveBeenCalledWith('connections', 'ways');
  });

  it('connects a disconnected account again as the same account', async () => {
    const user = userEvent.setup();
    const transport = transportFor(
      summary({
        lifecycle: 'disconnected',
        externalCleanup: 'complete',
        readiness: createMockConnectionReadiness({
          state: 'gone',
          reason: 'disconnected',
          fix: { action: 'connect_again', fixableBy: 'person' },
        }),
      })
    );
    vi.mocked(transport.reconnectConnectorConnection).mockResolvedValue({
      flowId: 'flow-again',
    } as never);
    const handlers = renderPanel(transport);
    const fix = await screen.findByTestId('app-panel-fix');
    expect(fix).toHaveTextContent(CONNECTION_READINESS_COPY.disconnected.owner);
    await user.click(within(fix).getByRole('button', { name: 'Connect again' }));
    // The same account, through its own reconnect: never a new connection.
    await waitFor(() => expect(handlers.onSignInStarted).toHaveBeenCalledWith('flow-again'));
    expect(transport.reconnectConnectorConnection).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    );
    expect(handlers.onAddAnother).not.toHaveBeenCalled();
  });

  it('connects the app again through a way that works when its DorkOS account is unlinked', async () => {
    const user = userEvent.setup();
    const transport = transportFor(
      summary({
        readiness: createMockConnectionReadiness({
          state: 'needs_you',
          reason: 'dorkos_account_unlinked',
          fix: { action: 'connect_new', fixableBy: 'person' },
        }),
      })
    );
    const handlers = renderPanel(transport);
    const fix = await screen.findByTestId('app-panel-fix');
    await user.click(within(fix).getByRole('button', { name: 'Connect Gmail again' }));
    // A new connection through a way that works, never the dead account's own reconnect.
    expect(handlers.onAddAnother).toHaveBeenCalledWith('gmail');
    expect(transport.reconnectConnectorConnection).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Try it' })).not.toBeInTheDocument();
  });

  it('checks again when the DorkOS account can’t reach the app right now', async () => {
    const user = userEvent.setup();
    const transport = transportFor(
      summary({
        readiness: notReady('unavailable', 'dorkos_account_unavailable', 'Can’t reach it.', {
          action: 'retry',
          fixableBy: 'dorkos',
        }),
      })
    );
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({ services: [], warnings: [] });
    renderPanel(transport);
    const fix = await screen.findByTestId('app-panel-fix');
    const reads = vi.mocked(transport.getConnectorConnection).mock.calls.length;
    expect(transport.getConnectorCatalog).not.toHaveBeenCalledWith({ limit: 1 });
    await user.click(within(fix).getByRole('button', { name: 'Check again' }));
    // The catalog read is what makes the server try the DorkOS account again.
    await waitFor(() => expect(transport.getConnectorCatalog).toHaveBeenCalledWith({ limit: 1 }));
    await waitFor(() =>
      expect(vi.mocked(transport.getConnectorConnection).mock.calls.length).toBeGreaterThan(reads)
    );
  });

  it('says a change still applying, with no button: DorkOS is on it', async () => {
    renderPanel(
      transportFor(
        summary({
          readiness: notReady('finishing', 'access_updating', 'Updating who can use it…', {
            action: 'wait',
            fixableBy: 'dorkos',
          }),
        })
      )
    );
    const fix = await screen.findByTestId('app-panel-fix');
    expect(fix).toHaveTextContent('Updating who can use it…');
    expect(within(fix).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says when DorkOS tries a stalled sign-out again, and lets the person try now', async () => {
    // Pin the clock to midday: "five minutes from now" read near midnight is
    // tomorrow, and the panel then (correctly) names the day.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 28, 12, 0));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const user = userEvent.setup();
    const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const transport = transportFor(
      summary({
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        readiness: notReady(
          'gone',
          'disconnect_finishing',
          'Disconnected. DorkOS is still removing its access at the service.',
          { action: 'retry', fixableBy: 'dorkos', retryAt }
        ),
      })
    );
    vi.mocked(transport.disconnectConnectorConnection).mockResolvedValue({} as never);
    renderPanel(transport);
    const fix = await screen.findByTestId('app-panel-fix');
    expect(fix).toHaveTextContent('DorkOS is still removing its access at the service.');
    expect(fix).toHaveTextContent(/Trying again at .+\./);
    await user.click(within(fix).getByRole('button', { name: 'Try again now' }));
    await waitFor(() => expect(transport.disconnectConnectorConnection).toHaveBeenCalledTimes(1));
    // Removing always works, even while DorkOS still owes the service a cleanup.
    expect(within(fix).getByTestId('remove-account')).toBeEnabled();
    await user.click(within(fix).getByTestId('remove-account'));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove Gmail from your apps?',
    });
    expect(confirm).toHaveTextContent('DorkOS still finishes removing its access at the service.');
  });

  it('offers removing, and the service’s own page, for a disconnect whose DorkOS account link ended', async () => {
    // The live incident: the link ended overnight, and the panel offered a
    // retry that could never work while Remove was blocked.
    const user = userEvent.setup();
    const owner =
      'Disconnected. Agents can’t use it. DorkOS can’t finish removing its access at the service, because your DorkOS account isn’t linked anymore. To be sure its access ended, remove it in that app’s own account settings.';
    const transport = transportFor(
      summary({
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        authoritySync: {
          status: 'failed',
          reason: 'This computer isn’t linked to your DorkOS account anymore.',
        },
        readiness: createMockConnectionReadiness({
          state: 'gone',
          reason: 'disconnect_stuck',
          fix: { action: 'remove', fixableBy: 'person' },
          serviceAccessPage: { service: 'Google', url: 'https://myaccount.google.com/connections' },
          copy: { owner, agent: 'Agent line.' },
        }),
      })
    );
    vi.mocked(transport.removeConnectorConnection).mockResolvedValue(undefined as never);
    const handlers = renderPanel(transport);
    const fix = await screen.findByTestId('app-panel-fix');
    expect(fix).toHaveTextContent(owner);
    // The raw refusal stays on the server; no button that can't work.
    expect(fix).not.toHaveTextContent('instance');
    expect(
      screen.queryByRole('button', { name: /Try disconnecting again|Try again now/ })
    ).toBeNull();
    expect(within(fix).getByRole('link', { name: /Open Google settings/ })).toHaveAttribute(
      'href',
      'https://myaccount.google.com/connections'
    );
    // Remove is the one fix, offered once.
    expect(within(fix).queryByTestId('remove-account')).not.toBeInTheDocument();
    await user.click(within(fix).getByRole('button', { name: 'Remove from your apps' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove Gmail from your apps?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(transport.removeConnectorConnection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
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
    expect(more).toHaveTextContent('Your DorkOS account.');
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
      summary({
        lifecycle: 'disconnected',
        externalCleanup: 'complete',
        readiness: notReady('gone', 'disconnected', 'Disconnected. Agents can’t use it.', {
          action: 'connect_again',
          fixableBy: 'person',
        }),
      })
    );
    vi.mocked(transport.removeConnectorConnection).mockResolvedValue(undefined as never);
    const handlers = renderPanel(transport);

    const fix = await screen.findByTestId('app-panel-fix');
    expect(within(fix).getByRole('button', { name: 'Connect again' })).toBeEnabled();
    await user.click(await screen.findByTestId('remove-account'));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove Gmail from your apps?',
    });
    expect(transport.removeConnectorConnection).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
  });

  it.each([
    [
      'your own Composio key',
      'managed' as const,
      'Any usage charges go to your own Composio account.',
    ],
    ['your own Nango server', 'self-host' as const, null],
  ])('says who pays only when someone does: %s', async (_way, custody, line) => {
    const user = userEvent.setup();
    const connection = summary({ mode: 'byo', custody, payer: 'operator_byo' });
    const base = detail(connection);
    const transport = transportFor(connection);
    vi.mocked(transport.getConnectorConnection).mockResolvedValue({
      ...base,
      provider: { ...base.provider, mode: 'byo', custody, payer: 'operator_byo' },
    });
    renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: 'More' }));
    const more = screen.getByTestId('app-panel-more');
    // Never the old line that was false for a server the person runs.
    expect(more).not.toHaveTextContent('billed to you');
    expect(more).not.toHaveTextContent('covers its use');
    if (line) expect(more).toHaveTextContent(line);
    else expect(more).not.toHaveTextContent(/usage charges/);
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
    expect(more).toHaveTextContent('Your DorkOS account covers its use.');
    await user.click(within(more).getByRole('button', { name: /^Sign in again/ }));
    await waitFor(() => expect(handlers.onSignInStarted).toHaveBeenCalledWith('flow-2'));
  });
});
