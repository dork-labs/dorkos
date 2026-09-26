/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ChatAppSettings } from '../ui/ChatAppSettings';

afterEach(cleanup);

function renderSettings(transport: Transport) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ChatAppSettings />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** A config read whose only interesting part is the chat apps switch. */
async function configWith(
  relay: { enabled: boolean; initError?: string },
  base: Transport = createMockTransport()
) {
  const config = await base.getConfig();
  return vi.fn().mockResolvedValue({ ...config, relay });
}

/** The built-in delivery entry the three settings live on. */
function deliveryCatalog(config: Record<string, unknown>, enabled = true) {
  return [
    {
      manifest: {
        type: 'claude-code',
        displayName: 'Claude Code',
        description: 'Routes messages to agent sessions.',
        category: 'internal',
        builtin: true,
        multiInstance: false,
        configFields: [],
      },
      instances: [{ id: 'delivery-1', enabled, config }],
    },
  ];
}

describe('ChatAppSettings', () => {
  it('shows the three settings in plain words and saves each one', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConfig: await configWith({ enabled: true }),
      getAdapterCatalog: vi
        .fn()
        .mockResolvedValue(deliveryCatalog({ maxConcurrent: 3, defaultTimeoutMs: 300_000 })),
    });
    renderSettings(transport);

    const toggle = await screen.findByRole('switch', { name: /Start working right away/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() =>
      expect(transport.toggleRelayAdapter).toHaveBeenCalledWith('delivery-1', false)
    );

    const most = screen.getByLabelText('Most chats at once');
    expect(most).toHaveValue(3);
    await user.clear(most);
    await user.type(most, '5{Enter}');
    await waitFor(() =>
      expect(transport.updateRelayAdapterConfig).toHaveBeenCalledWith('delivery-1', {
        maxConcurrent: 5,
      })
    );

    // Seconds on screen, milliseconds on the wire.
    const giveUp = screen.getByLabelText('Give up after, in seconds');
    expect(giveUp).toHaveValue(300);
    await user.clear(giveUp);
    await user.type(giveUp, '90{Enter}');
    await waitFor(() =>
      expect(transport.updateRelayAdapterConfig).toHaveBeenCalledWith('delivery-1', {
        defaultTimeoutMs: 90_000,
      })
    );
    // Only the field that was edited is ever written.
    for (const [, config] of vi.mocked(transport.updateRelayAdapterConfig).mock.calls) {
      expect(Object.keys(config)).toHaveLength(1);
    }
  });

  it.each([
    [10_000, 10],
    [90_000, 90],
    [300_000, 300],
  ])('shows a stored wait of %i ms exactly as %i seconds', async (stored, seconds) => {
    const transport = createMockTransport({
      getConfig: await configWith({ enabled: true }),
      getAdapterCatalog: vi
        .fn()
        .mockResolvedValue(deliveryCatalog({ maxConcurrent: 3, defaultTimeoutMs: stored })),
    });
    renderSettings(transport);
    expect(await screen.findByLabelText('Give up after, in seconds')).toHaveValue(seconds);
  });

  it('accepts the 10-second floor and nothing below it', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConfig: await configWith({ enabled: true }),
      getAdapterCatalog: vi.fn().mockResolvedValue(deliveryCatalog({ defaultTimeoutMs: 300_000 })),
    });
    renderSettings(transport);
    const giveUp = await screen.findByLabelText('Give up after, in seconds');
    await user.clear(giveUp);
    await user.type(giveUp, '9{Enter}');
    expect(await screen.findByText('Enter a whole number from 10 to 3600.')).toBeInTheDocument();
    expect(transport.updateRelayAdapterConfig).not.toHaveBeenCalled();
    await user.clear(giveUp);
    await user.type(giveUp, '10{Enter}');
    await waitFor(() =>
      expect(transport.updateRelayAdapterConfig).toHaveBeenCalledWith('delivery-1', {
        defaultTimeoutMs: 10_000,
      })
    );
  });

  it('editing another setting leaves the stored wait untouched', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConfig: await configWith({ enabled: true }),
      getAdapterCatalog: vi
        .fn()
        .mockResolvedValue(deliveryCatalog({ maxConcurrent: 3, defaultTimeoutMs: 90_000 })),
    });
    renderSettings(transport);
    const most = await screen.findByLabelText('Most chats at once');
    await user.clear(most);
    await user.type(most, '4{Enter}');
    await waitFor(() => expect(transport.updateRelayAdapterConfig).toHaveBeenCalledTimes(1));
    expect(transport.updateRelayAdapterConfig).toHaveBeenCalledWith('delivery-1', {
      maxConcurrent: 4,
    });
    expect(screen.getByLabelText('Give up after, in seconds')).toHaveValue(90);
  });

  it('never saves a number out of range', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConfig: await configWith({ enabled: true }),
      getAdapterCatalog: vi.fn().mockResolvedValue(deliveryCatalog({})),
    });
    renderSettings(transport);
    const most = await screen.findByLabelText('Most chats at once');
    await user.clear(most);
    await user.type(most, '99{Enter}');
    expect(await screen.findByText('Enter a whole number from 1 to 20.')).toBeInTheDocument();
    expect(transport.updateRelayAdapterConfig).not.toHaveBeenCalled();
  });

  it('says when chat apps are switched off on this server', async () => {
    renderSettings(createMockTransport({ getConfig: await configWith({ enabled: false }) }));
    expect(await screen.findByText('DORKOS_RELAY_ENABLED=true dorkos')).toBeInTheDocument();
    expect(screen.queryByLabelText('Most chats at once')).toBeNull();
  });

  it('tells a startup failure apart from switched off', async () => {
    renderSettings(
      createMockTransport({ getConfig: await configWith({ enabled: false, initError: 'boom' }) })
    );
    expect(await screen.findByText('Chat apps didn’t start')).toBeInTheDocument();
  });

  it('says so plainly when there is nothing to set', async () => {
    renderSettings(createMockTransport({ getConfig: await configWith({ enabled: true }) }));
    expect(
      await screen.findByText(/no way to start agents from chat messages/)
    ).toBeInTheDocument();
  });
});
