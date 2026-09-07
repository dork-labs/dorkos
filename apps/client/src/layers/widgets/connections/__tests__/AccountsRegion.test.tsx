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
