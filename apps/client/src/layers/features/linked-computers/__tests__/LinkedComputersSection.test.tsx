// @vitest-environment jsdom
/**
 * Linked computers (DOR-2946): nothing off a hub; on a hub, the owner's
 * computers with Remove, and a one-time code to link another.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { LinkedComputersSection } from '../ui/LinkedComputersSection';

function renderSection(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <LinkedComputersSection />
      </TransportProvider>
    </QueryClientProvider>
  );
}

const STUDIO = {
  computerId: 'mac-1',
  computerName: 'Studio Mac',
  linkedAt: '2026-10-16T12:00:00.000Z',
  connected: true,
  features: ['chats.list'],
};

afterEach(() => cleanup());

describe('LinkedComputersSection', () => {
  it('draws nothing off a hub', async () => {
    const transport = createMockTransport();
    const { container } = renderSection(transport);
    await waitFor(() => expect(transport.listHubComputers).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the linked computers and removes one', async () => {
    const listHubComputers = vi
      .fn()
      .mockResolvedValueOnce({ computers: [STUDIO] })
      .mockResolvedValue({ computers: [] });
    const removeHubComputer = vi.fn().mockResolvedValue(undefined);
    renderSection(createMockTransport({ listHubComputers, removeHubComputer }));

    expect(await screen.findByText('Studio Mac')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Studio Mac' }));
    expect(removeHubComputer).toHaveBeenCalledWith('mac-1');
    expect(await screen.findByText('No computers linked yet.')).toBeInTheDocument();
  });

  it('names a computer linked without a name by its id', async () => {
    renderSection(
      createMockTransport({
        listHubComputers: vi.fn().mockResolvedValue({
          computers: [{ ...STUDIO, computerName: null, connected: false }],
        }),
      })
    );
    expect(await screen.findByText('mac-1')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
  });

  it('mints a code and shows it with a copy button and its expiry', async () => {
    const createHubLinkCode = vi.fn().mockResolvedValue({
      linkCode: '7K3M-Q9TD-X2HV-8RNB@me.dorkos.app',
      expiresAt: '2026-10-16T12:10:00.000Z',
    });
    renderSection(
      createMockTransport({
        listHubComputers: vi.fn().mockResolvedValue({ computers: [] }),
        createHubLinkCode,
      })
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Link a computer' }));
    expect(createHubLinkCode).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('hub-link-code')).toHaveTextContent(
      '7K3M-Q9TD-X2HV-8RNB@me.dorkos.app'
    );
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(screen.getByText(/^Works once, until /)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('hub-link-code')).not.toBeInTheDocument();
  });

  it('says so when a code cannot be made', async () => {
    renderSection(
      createMockTransport({
        listHubComputers: vi.fn().mockResolvedValue({ computers: [] }),
        createHubLinkCode: vi.fn().mockRejectedValue(new Error('nope')),
      })
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Link a computer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t make a code. Try again.');
  });
});
