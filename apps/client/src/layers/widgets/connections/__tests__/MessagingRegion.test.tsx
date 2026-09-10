/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

vi.mock('@/layers/entities/relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/relay')>();
  return { ...actual, useRelayEventStream: vi.fn() };
});

vi.mock('@/layers/features/relay', () => ({
  MessagingConnections: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="messaging-connections" data-enabled={enabled} />
  ),
  ActivityFeed: () => null,
  RelayHealthBar: () => null,
}));

vi.mock('@/layers/features/connections', () => ({
  ClaimFeed: () => null,
  MessagePolicyCard: () => null,
}));

import { MessagingRegion } from '../ui/MessagingRegion';

afterEach(cleanup);

function renderRegion(transport: Transport) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return render(<MessagingRegion />, { wrapper: Wrapper });
}

function configWithRelay(relay: {
  enabled: boolean;
  enabledInConfig?: boolean;
  lockedByEnv?: boolean;
  initError?: string;
}) {
  return {
    version: '1.0.0',
    port: 4242,
    uptime: 0,
    workingDirectory: '/test',
    nodeVersion: 'v24.0.0',
    claudeCliPath: null,
    tunnel: {
      enabled: false,
      connected: false,
      url: null,
      authEnabled: false,
      tokenConfigured: false,
    },
    relay,
  };
}

describe('MessagingRegion runtime state', () => {
  it('keeps an unanswered config read in a loading state', () => {
    const transport = createMockTransport({
      getConfig: vi.fn(() => new Promise<never>(() => {})),
    });

    renderRegion(transport);

    expect(screen.getByLabelText('Loading Messaging')).toBeInTheDocument();
    expect(screen.queryByText('Messaging is off')).not.toBeInTheDocument();
  });

  it('shows a config failure and retries into the truthful disabled state', async () => {
    const user = userEvent.setup();
    const getConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockResolvedValue(configWithRelay({ enabled: false, lockedByEnv: true }));

    renderRegion(createMockTransport({ getConfig }));

    expect(await screen.findByText('Couldn’t check Messaging')).toBeInTheDocument();
    expect(screen.queryByText('Messaging is off')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Messaging is off')).toBeInTheDocument();
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2));
  });

  it('distinguishes a startup failure from an explicit disabled state', async () => {
    renderRegion(
      createMockTransport({
        getConfig: vi.fn().mockResolvedValue(
          configWithRelay({
            enabled: false,
            enabledInConfig: true,
            initError: 'database unavailable',
          })
        ),
      })
    );

    expect(await screen.findByText('Messaging didn’t start')).toBeInTheDocument();
    expect(screen.queryByText('Messaging is off')).not.toBeInTheDocument();
  });

  it('renders Messaging only after config confirms it is running', async () => {
    renderRegion(
      createMockTransport({
        getConfig: vi.fn().mockResolvedValue(configWithRelay({ enabled: true })),
      })
    );

    expect(await screen.findByTestId('messaging-connections')).toHaveAttribute(
      'data-enabled',
      'true'
    );
    expect(screen.queryByText('Messaging is off')).not.toBeInTheDocument();
  });
});
