/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdapterBinding, CatalogInstance } from '@dorkos/shared/relay-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ChatAppAnswerers } from '../ChatAppAnswerers';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

const BOT: CatalogInstance = {
  id: 'telegram-1',
  enabled: true,
  label: '@lifeos_bot',
  status: {
    id: 'telegram-1',
    type: 'telegram',
    displayName: 'Telegram',
    state: 'connected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  },
};

function renderAnswerers(transport: Transport) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ChatAppAnswerers instance={BOT} appName="Telegram" />
      </TransportProvider>
    </QueryClientProvider>
  );
}

function transportWith(bindings: AdapterBinding[]) {
  return createMockTransport({
    getBindings: vi.fn().mockResolvedValue(bindings),
    listMeshAgents: vi.fn().mockResolvedValue({
      agents: [
        { id: 'dorkbot', name: 'DorkBot' },
        { id: 'mailroom', name: 'mailroom' },
      ],
    }),
  });
}

describe('ChatAppAnswerers', () => {
  it('with nobody answering, picks one agent in one step with the usual defaults', async () => {
    const user = userEvent.setup();
    const transport = transportWith([]);
    vi.mocked(transport.createBinding).mockResolvedValue({ id: 'b-1' } as AdapterBinding);
    renderAnswerers(transport);

    expect(await screen.findByText(/No agent answers yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pick who answers' }));
    await user.click(await screen.findByRole('option', { name: 'DorkBot' }));

    await waitFor(() =>
      expect(transport.createBinding).toHaveBeenCalledWith({
        adapterId: 'telegram-1',
        agentId: 'dorkbot',
        sessionStrategy: 'per-chat',
        label: '',
      })
    );
  });

  it('names who answers today', async () => {
    renderAnswerers(
      transportWith([
        {
          id: 'b-1',
          adapterId: 'telegram-1',
          agentId: 'mailroom',
          sessionStrategy: 'per-chat',
        } as AdapterBinding,
        { id: 'b-2', adapterId: 'slack-1', agentId: 'dorkbot' } as AdapterBinding,
      ])
    );
    expect(await screen.findByText('mailroom')).toBeInTheDocument();
    expect(screen.queryByText('DorkBot')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add an agent' })).toBeInTheDocument();
  });

  it('offers to move a chat someone else already answers, instead of failing', async () => {
    const user = userEvent.setup();
    const transport = transportWith([]);
    vi.mocked(transport.createBinding).mockRejectedValue(
      Object.assign(new Error('taken'), {
        code: 'CHAT_ALREADY_BOUND',
        body: { conflict: { bindingId: 'b-old', agentId: 'mailroom' } },
      })
    );
    renderAnswerers(transport);

    await user.click(await screen.findByRole('button', { name: 'Pick who answers' }));
    await user.click(await screen.findByRole('option', { name: 'DorkBot' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/mailroom/);
  });
});
