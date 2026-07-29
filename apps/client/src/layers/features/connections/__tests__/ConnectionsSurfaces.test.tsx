/**
 * @vitest-environment jsdom
 *
 * The /connections building blocks: provider setup cards (key entry, verbatim
 * refusal errors, delete-with-confirm), the service-first grid (tiles, honest
 * empty state, warnings), and the accounts list (multi-account rows, the
 * server-composed custody sentence, disconnect-with-confirm).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectorProviderStatus,
  PublicConnectedAccount,
} from '@dorkos/shared/connector-provider';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ProviderSetupCard } from '../ui/ProviderSetupCard';
import { ServiceGrid } from '../ui/ServiceGrid';
import { AccountsList } from '../ui/AccountsList';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

const unconfigured: ConnectorProviderStatus = {
  type: 'composio',
  configured: false,
  registered: false,
  custody: 'managed',
  disclosure:
    "Composio stores your connected accounts' login access in its own secure vault, not on your computer.",
};

const NANGO_REFUSAL =
  'NANGO_ENCRYPTION_KEY is not set. Set it before configuring the Nango secret key.';

function account(over: Partial<PublicConnectedAccount>): PublicConnectedAccount {
  return {
    id: 'acct-1' as PublicConnectedAccount['id'],
    toolkit: 'gmail',
    label: 'work',
    status: 'active',
    custody: 'managed',
    disclosure:
      'Connecting work takes you to that service to sign in. Composio stores your connected ' +
      "accounts' login access in its own secure vault, not on your computer.",
    ...over,
  };
}

function renderWith(transport: Transport, ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('ProviderSetupCard', () => {
  it('shows the custody stance and saves a pasted key as a password field', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.putConnectorCredential).mockResolvedValue({
      ...unconfigured,
      configured: true,
      registered: true,
    });

    renderWith(transport, <ProviderSetupCard status={unconfigured} />);

    // Custody stance line, server copy verbatim.
    expect(screen.getByText(unconfigured.disclosure)).toBeInTheDocument();

    const input = screen.getByLabelText(/Composio API key/i);
    // The key never renders readable — a password input.
    expect(input).toHaveAttribute('type', 'password');
    await user.type(input, 'sk-secret');
    await user.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() =>
      expect(transport.putConnectorCredential).toHaveBeenCalledWith('composio', 'sk-secret')
    );
  });

  it('renders a configured provider that refused to register with the verbatim error', () => {
    const transport = createMockTransport();
    renderWith(
      transport,
      <ProviderSetupCard
        status={{
          type: 'nango',
          configured: true,
          registered: false,
          custody: 'self-host',
          disclosure: "You're connecting through your own Nango server.",
          error: NANGO_REFUSAL,
        }}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(NANGO_REFUSAL);
    expect(screen.getByText('Not running')).toBeInTheDocument();
  });

  it('deletes the key only after the person confirms', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.deleteConnectorCredential).mockResolvedValue(unconfigured);

    renderWith(
      transport,
      <ProviderSetupCard status={{ ...unconfigured, configured: true, registered: true }} />
    );

    await user.click(screen.getByRole('button', { name: /remove key/i }));
    // Confirm dialog interposes — nothing deleted yet.
    expect(transport.deleteConnectorCredential).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove key' }));
    await waitFor(() =>
      expect(transport.deleteConnectorCredential).toHaveBeenCalledWith('composio')
    );
  });
});

describe('ServiceGrid', () => {
  it('renders service-first tiles with one Connect verb and no vendor names', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorToolkits).mockResolvedValue({
      toolkits: [
        { slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' },
        { slug: 'slack', displayName: 'Slack', authKind: 'oauth2' },
      ],
      warnings: [],
    });

    renderWith(transport, <ServiceGrid />);

    expect(await screen.findByText('Gmail')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
    // Provider choice is invisible on the grid.
    expect(screen.queryByText(/composio/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/nango/i)).not.toBeInTheDocument();
  });

  it('points an empty grid at provider setup', async () => {
    const transport = createMockTransport();
    renderWith(transport, <ServiceGrid />);
    expect(await screen.findByText('No services to connect yet')).toBeInTheDocument();
    expect(screen.getByText(/add a provider key/i)).toBeInTheDocument();
  });

  it('surfaces provider degradation warnings instead of hiding them', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorToolkits).mockResolvedValue({
      toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
      warnings: [{ provider: 'nango', message: 'nango timed out after 5000ms' }],
    });

    renderWith(transport, <ServiceGrid />);
    expect(await screen.findByText(/nango timed out after 5000ms/)).toBeInTheDocument();
  });
});

describe('AccountsList', () => {
  it('renders two accounts of one service as distinct rows, each with its custody sentence', async () => {
    const transport = createMockTransport();
    const work = account({});
    const personal = account({
      id: 'acct-2' as PublicConnectedAccount['id'],
      label: 'personal',
      disclosure: 'Connecting personal takes you to that service to sign in.',
    });
    vi.mocked(transport.getConnectorAccounts).mockResolvedValue({
      accounts: [work, personal],
      warnings: [],
    });

    renderWith(transport, <AccountsList />);

    expect(await screen.findByText('Gmail (work)')).toBeInTheDocument();
    expect(screen.getByText('Gmail (personal)')).toBeInTheDocument();
    // The per-account custody sentence comes from the API — asserted verbatim.
    expect(screen.getByText(work.disclosure)).toBeInTheDocument();
    expect(screen.getByText(personal.disclosure)).toBeInTheDocument();
  });

  it('marks an expired account so trouble reads as trouble', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorAccounts).mockResolvedValue({
      accounts: [account({ status: 'expired' })],
      warnings: [],
    });

    renderWith(transport, <AccountsList />);
    expect(await screen.findByText('expired')).toBeInTheDocument();
  });

  it('disconnects only after the person confirms', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorAccounts).mockResolvedValue({
      accounts: [account({})],
      warnings: [],
    });

    renderWith(transport, <AccountsList />);

    await user.click(await screen.findByRole('button', { name: /disconnect/i }));
    expect(transport.disconnectConnectorAccount).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(transport.disconnectConnectorAccount).toHaveBeenCalledWith('acct-1')
    );
  });

  it('shows the honest empty state', async () => {
    const transport = createMockTransport();
    renderWith(transport, <AccountsList />);
    expect(await screen.findByText(/nothing connected yet/i)).toBeInTheDocument();
  });
});
