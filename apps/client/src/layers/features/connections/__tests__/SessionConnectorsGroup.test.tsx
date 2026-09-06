/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionConnectorStatus } from '@dorkos/shared/connector-provider';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { SessionConnectorsGroup } from '../ui/SessionConnectorsGroup';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const inheritedStatus: SessionConnectorStatus = {
  accounts: [
    {
      accountId: 'acct-1' as SessionConnectorStatus['accounts'][number]['accountId'],
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      access: 'inherited',
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
  it('renders nothing while the session has no inherited or explicit access', async () => {
    const transport = createMockTransport();
    renderGroup(transport);
    await waitFor(() => expect(transport.getSessionConnectors).toHaveBeenCalled());
    expect(screen.queryByTestId('session-connectors')).not.toBeInTheDocument();
  });

  it('renders inherited access without an attach or detach control', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectors).mockResolvedValue(inheritedStatus);
    renderGroup(transport);

    expect(await screen.findByText('Gmail (work)')).toBeInTheDocument();
    expect(screen.getByText('Agent access')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /attach|detach/i })).not.toBeInTheDocument();
    expect(transport.getConnectorAccounts).not.toHaveBeenCalled();
  });

  it('states that an explicit session block survives later agent access changes', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectors).mockResolvedValue({
      accounts: [{ ...inheritedStatus.accounts[0], access: 'session_blocked' }],
      warnings: [],
    });
    renderGroup(transport);

    expect(await screen.findByText('Blocked for session')).toBeInTheDocument();
    expect(screen.getByText(/Agent access does not replace a session block/i)).toBeInTheDocument();
  });

  it('links owner changes to the Connections workspace', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectors).mockResolvedValue(inheritedStatus);
    renderGroup(transport);

    await user.click(await screen.findByRole('button', { name: /manage agent access/i }));
    expect(navigate).toHaveBeenCalledWith({ to: '/connections' });
  });

  it('surfaces an unavailable connection beside its durable access state', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectors).mockResolvedValue({
      accounts: [{ ...inheritedStatus.accounts[0], status: 'expired' }],
      warnings: [
        { accountId: inheritedStatus.accounts[0].accountId, label: 'work', reason: 'expired' },
      ],
    });
    renderGroup(transport);

    expect(await screen.findByRole('alert')).toHaveTextContent('expired. Reconnect');
  });
});
