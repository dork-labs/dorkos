/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AccountsRegion } from '../ui/AccountsRegion';

const openSettings = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
afterEach(cleanup);

function renderRegion(transport: Transport) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <AccountsRegion />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('AccountsRegion', () => {
  it('opens existing account settings without starting a link automatically', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    renderRegion(transport);
    await user.click(await screen.findByRole('button', { name: 'Link DorkOS account' }));
    expect(openSettings).toHaveBeenCalledWith('access', 'account');
    expect(transport.startCloudLink).not.toHaveBeenCalled();
  });

  it('does not prompt an already linked owner to link again', async () => {
    renderRegion(
      createMockTransport({
        getCloudStatus: vi
          .fn()
          .mockResolvedValue({ linked: true, accountLabel: null, lastHeartbeatAt: null }),
      })
    );
    await screen.findByText('No accounts connected');
    expect(screen.queryByRole('button', { name: 'Link DorkOS account' })).not.toBeInTheDocument();
  });

  it('does not mistake loading or a failed status read for an unlinked account', async () => {
    let rejectStatus!: (error: Error) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectStatus = reject;
          })
      )
      .mockResolvedValue({ linked: false, accountLabel: null, lastHeartbeatAt: null });
    renderRegion(createMockTransport({ getCloudStatus: read }));
    expect(screen.getByLabelText('Checking DorkOS account')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link DorkOS account' })).not.toBeInTheDocument();
    rejectStatus(new Error('private diagnostic value'));
    await screen.findByText('Couldn’t check your DorkOS account');
    expect(screen.queryByText('private diagnostic value')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Link DorkOS account' })).toBeInTheDocument();
  });

  it('surfaces catalog unavailability safely and lets a linked owner retry', async () => {
    const read = vi.fn().mockRejectedValue(new Error('private deployment detail'));
    renderRegion(
      createMockTransport({
        getCloudStatus: vi
          .fn()
          .mockResolvedValue({ linked: true, accountLabel: null, lastHeartbeatAt: null }),
        getConnectorCatalog: read,
      })
    );
    await screen.findByText('Some services couldn’t load');
    expect(screen.queryByText('private deployment detail')).not.toBeInTheDocument();
    const previousReads = read.mock.calls.length;
    read.mockResolvedValue({ services: [], warnings: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByText('Some services couldn’t load')).not.toBeInTheDocument()
    );
    expect(read).toHaveBeenCalledTimes(previousReads + 1);
  });

  it('keeps one service action and a calm empty account inventory', async () => {
    const transport = createMockTransport();
    renderRegion(transport);
    expect(screen.getByRole('button', { name: 'Connect service' })).toBeInTheDocument();
    expect(await screen.findByText('No accounts connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Advanced account setup' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('shows an account read failure as an error and retries the canonical resource', async () => {
    const user = userEvent.setup();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ connections: [] });
    renderRegion(createMockTransport({ getConnectorConnections: read }));
    expect(await screen.findByText('Couldn’t load connected accounts')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No accounts connected')).toBeInTheDocument();
  });

  it('keeps BYO provider setup behind the explicit advanced action', async () => {
    const user = userEvent.setup();
    renderRegion(createMockTransport());
    expect(screen.queryByText(/Use your own Composio or Nango account/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Advanced account setup' }));
    expect(screen.getByText(/Use your own Composio or Nango account/i)).toBeVisible();
  });
});
