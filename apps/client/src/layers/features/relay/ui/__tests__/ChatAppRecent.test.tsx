/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdapterEvent, Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ChatAppRecent } from '../ChatAppRecent';

afterEach(cleanup);

function event(id: string, subject: string, minutesAgo: number, message?: string): AdapterEvent {
  return {
    id,
    subject,
    status: 'delivered',
    sentAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    metadata: message
      ? JSON.stringify({ adapterId: 'telegram-1', eventType: subject, message })
      : null,
  };
}

function renderRecent(events: AdapterEvent[]): Transport {
  const transport = createMockTransport({
    getAdapterEvents: vi.fn().mockResolvedValue({ events }),
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TransportProvider transport={transport}>
        <ChatAppRecent adapterId="telegram-1" />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('ChatAppRecent', () => {
  it('shows the three newest events, in the order the server sends them (newest first)', async () => {
    renderRecent([
      event('e4', 'adapter.message_sent', 1),
      event('e3', 'adapter.message_received', 2),
      event('e2', 'adapter.status_change', 30),
      event('e1', 'adapter.connected', 600),
    ]);

    const items = await screen.findAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('A reply went out'),
      expect.stringContaining('A message came in'),
      expect.stringContaining('Its status changed'),
    ]);
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('offers "See all" even with three events or fewer, and opens the full log', async () => {
    const user = userEvent.setup();
    renderRecent([event('e1', 'adapter.connected', 5)]);

    await user.click(await screen.findByRole('button', { name: 'See all' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('opens an error line to show the whole message', async () => {
    const user = userEvent.setup();
    const long = "Call to 'getMe' failed! (401: Unauthorized) because the bot token was revoked";
    renderRecent([event('e1', 'adapter.error', 5, long)]);

    const line = await screen.findByRole('button', { name: /Something went wrong/ });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    await user.click(line);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(line).toHaveTextContent(long);
  });
});
