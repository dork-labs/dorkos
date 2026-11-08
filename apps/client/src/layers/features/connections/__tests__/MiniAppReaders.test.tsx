/** "Mini apps that can read this" on an account's panel (DOR-3547). Made-up data. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MiniAppReaders } from '../ui/panel/MiniAppReaders';

afterEach(cleanup);

const ALLOWED = {
  approvalId: 'approval-1',
  extensionId: 'flow-owner',
  extensionName: 'Flow',
  service: 'linear',
  connectionId: 'linear-work',
  connectionLabel: 'Work Linear',
  approvedAt: '2026-11-08T12:00:00.000Z',
};

function renderReaders(transport: Transport, connectionId = 'linear-work') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <MiniAppReaders connectionId={connectionId} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('MiniAppReaders', () => {
  it('lists each mini app allowed on this account, and Revoke takes it back', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getMiniAppAccess: vi.fn().mockResolvedValue({
        waiting: [],
        allowed: [ALLOWED, { ...ALLOWED, approvalId: 'approval-2', connectionId: 'other' }],
      }),
    });
    renderReaders(transport);

    expect(await screen.findByText('Flow')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Revoke Flow' }));
    expect(transport.revokeMiniAppAccess).toHaveBeenCalledWith('approval-1');
  });

  it('renders nothing when no mini app can read this account', async () => {
    const transport = createMockTransport({
      getMiniAppAccess: vi.fn().mockResolvedValue({ waiting: [], allowed: [ALLOWED] }),
    });
    renderReaders(transport, 'another-account');
    await vi.waitFor(() => expect(transport.getMiniAppAccess).toHaveBeenCalled());
    expect(screen.queryByTestId('mini-app-readers')).not.toBeInTheDocument();
  });
});
