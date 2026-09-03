/**
 * @vitest-environment jsdom
 *
 * The session view's Connectors group: silent until relevant, attached rows
 * with null-branch warnings, attach with the disclosure on screen before the
 * consent click, one-action detach.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type {
  PublicConnectedAccount,
  SessionConnectorStatus,
} from '@dorkos/shared/connector-provider';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { SessionConnectorsGroup } from '../ui/SessionConnectorsGroup';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

const workAccount: PublicConnectedAccount = {
  id: 'acct-1' as PublicConnectedAccount['id'],
  toolkit: 'gmail',
  label: 'work',
  status: 'active',
  custody: 'managed',
  disclosure:
    'Connecting work takes you to that service to sign in. Composio stores your connected ' +
    "accounts' login access in its own secure vault, not on your computer.",
};

const attachedStatus: SessionConnectorStatus = {
  accounts: [
    {
      accountId: workAccount.id,
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      serverName: 'gmail-work',
      exposed: true,
    },
  ],
  warnings: [],
};

function renderGroup(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <SessionConnectorsGroup sessionId="sess-1" />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('SessionConnectorsGroup', () => {
  it('renders nothing while no account is connected or attached (quiet until relevant)', async () => {
    const transport = createMockTransport();
    renderGroup(transport);
    await waitFor(() => expect(transport.getSessionConnectors).toHaveBeenCalled());
    expect(screen.queryByTestId('session-connectors')).not.toBeInTheDocument();
  });

  it('lists attached accounts with exposure state', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectors).mockResolvedValue(attachedStatus);

    renderGroup(transport);

    expect(await screen.findByText('Gmail (work)')).toBeInTheDocument();
    expect(screen.getByText('tools on')).toBeInTheDocument();
  });

  it('surfaces the null-branch warning as a reconnect prompt, never silently', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectors).mockResolvedValue({
      accounts: [{ ...attachedStatus.accounts[0], status: 'expired', exposed: false }],
      warnings: [{ accountId: workAccount.id, label: 'work', reason: 'expired' }],
    });

    renderGroup(transport);

    expect(await screen.findByText('no tools')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('expired. Reconnect');
  });

  it('shows the custody disclosure before the attach consent click', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorAccounts).mockResolvedValue({
      accounts: [workAccount],
      warnings: [],
    });
    vi.mocked(transport.attachSessionConnector).mockResolvedValue({
      account: attachedStatus.accounts[0],
      disclosure: workAccount.disclosure,
    });

    renderGroup(transport);

    await user.click(await screen.findByRole('button', { name: /attach account/i }));
    await user.click(screen.getByRole('button', { name: 'Gmail (work)' }));

    // The consent point: the account's server-composed sentence is on screen…
    expect(screen.getByTestId('attach-disclosure')).toHaveTextContent(workAccount.disclosure);
    // …and nothing has been attached yet.
    expect(transport.attachSessionConnector).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() =>
      expect(transport.attachSessionConnector).toHaveBeenCalledWith('sess-1', 'acct-1')
    );
  });

  it('keeps the attach receipt visible when the account attached but is not exposable', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorAccounts).mockResolvedValue({
      accounts: [workAccount],
      warnings: [],
    });
    vi.mocked(transport.attachSessionConnector).mockResolvedValue({
      account: { ...attachedStatus.accounts[0], exposed: false },
      disclosure: workAccount.disclosure,
      warning: { accountId: workAccount.id, label: 'work', reason: 'unavailable' },
    });

    renderGroup(transport);

    await user.click(await screen.findByRole('button', { name: /attach account/i }));
    await user.click(screen.getByRole('button', { name: 'Gmail (work)' }));
    await user.click(screen.getByRole('button', { name: 'Attach' }));

    expect(
      await screen.findByText(
        /Attached, but there is a problem\. This account is not available right now\./i
      )
    ).toBeInTheDocument();
  });

  it('detaches an account with one action', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectors).mockResolvedValue(attachedStatus);

    renderGroup(transport);

    await user.click(
      await screen.findByRole('button', { name: 'Detach Gmail (work) from this session' })
    );
    await waitFor(() =>
      expect(transport.detachSessionConnector).toHaveBeenCalledWith('sess-1', 'acct-1')
    );
  });
});
