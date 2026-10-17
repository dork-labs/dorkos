// @vitest-environment jsdom
/**
 * "Remote session active" (DOR-2946): drawn only while someone is using this
 * computer from the web, kept live by `session_relay_presence`, listing the
 * browsers seen, and offering "End now" only at this computer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionRelayPresence } from '@dorkos/shared/session-relay-link';
import { configKeys, TransportProvider } from '@/layers/shared/model';

const handlers = new Map<string, (data: unknown) => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (name: string, handler: (data: unknown) => void) => {
      handlers.set(name, handler);
    },
  };
});

import { RemoteSessionIndicator } from '../ui/RemoteSessionIndicator';

const INACTIVE: SessionRelayPresence = { active: false, devices: [] };
const ACTIVE: SessionRelayPresence = {
  active: true,
  since: new Date(Date.now() - 60_000).toISOString(),
  devices: [
    {
      label: 'Safari on iPhone',
      firstSeenAt: '2026-10-17T09:00:00.000Z',
      lastSeenAt: new Date().toISOString(),
    },
  ],
};

function renderIndicator(
  overrides: Partial<Transport>,
  options: { on?: boolean; local?: boolean } = {}
) {
  const config = {
    experiments: [
      {
        key: 'sessionRelay.enabled',
        title: 'Chat from the web',
        description: '',
        enabled: options.on ?? true,
        lockedByEnv: false,
      },
    ],
    serverRole: 'computer',
    isLocalCaller: options.local ?? true,
  };
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    ...overrides,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RemoteSessionIndicator />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

afterEach(() => {
  cleanup();
  handlers.clear();
});

describe('RemoteSessionIndicator', () => {
  it('draws nothing while nobody is using this computer from the web', async () => {
    const getSessionRelayPresence = vi.fn().mockResolvedValue(INACTIVE);
    renderIndicator({ getSessionRelayPresence });
    await waitFor(() => expect(getSessionRelayPresence).toHaveBeenCalled());
    expect(screen.queryByTestId('remote-session-indicator')).not.toBeInTheDocument();
  });

  it('asks nothing and draws nothing with the experiment off', async () => {
    const getSessionRelayPresence = vi.fn().mockResolvedValue(ACTIVE);
    renderIndicator({ getSessionRelayPresence }, { on: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getSessionRelayPresence).not.toHaveBeenCalled();
    expect(screen.queryByTestId('remote-session-indicator')).not.toBeInTheDocument();
  });

  it('appears and goes with the live event, and ignores one of the wrong shape', async () => {
    const getSessionRelayPresence = vi.fn().mockResolvedValue(INACTIVE);
    renderIndicator({ getSessionRelayPresence });
    await waitFor(() => expect(handlers.has('session_relay_presence')).toBe(true));
    act(() => handlers.get('session_relay_presence')!(ACTIVE));
    expect(await screen.findByTestId('remote-session-indicator')).toHaveAccessibleName(
      'In use from the web. Show details'
    );
    act(() => handlers.get('session_relay_presence')!({ active: 'yes' }));
    expect(screen.getByTestId('remote-session-indicator')).toBeInTheDocument();
    act(() => handlers.get('session_relay_presence')!(INACTIVE));
    await waitFor(() =>
      expect(screen.queryByTestId('remote-session-indicator')).not.toBeInTheDocument()
    );
  });

  it('lists the browsers and ends it now, at this computer', async () => {
    const endSessionRelayPresence = vi.fn().mockResolvedValue(INACTIVE);
    renderIndicator({
      getSessionRelayPresence: vi.fn().mockResolvedValue(ACTIVE),
      endSessionRelayPresence,
    });
    await userEvent.click(await screen.findByTestId('remote-session-indicator'));
    expect(screen.getByText('In use from the web')).toBeInTheDocument();
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'End now' }));
    expect(endSessionRelayPresence).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByTestId('remote-session-indicator')).not.toBeInTheDocument()
    );
  });

  it('offers no End now anywhere but this computer', async () => {
    const endSessionRelayPresence = vi.fn();
    renderIndicator(
      { getSessionRelayPresence: vi.fn().mockResolvedValue(ACTIVE), endSessionRelayPresence },
      { local: false }
    );
    await userEvent.click(await screen.findByTestId('remote-session-indicator'));
    expect(screen.queryByRole('button', { name: 'End now' })).not.toBeInTheDocument();
    expect(screen.getByText('End it on the computer DorkOS runs on.')).toBeInTheDocument();
    expect(endSessionRelayPresence).not.toHaveBeenCalled();
  });

  it('says so when no browser has been named yet', async () => {
    renderIndicator({
      getSessionRelayPresence: vi.fn().mockResolvedValue({ ...ACTIVE, devices: [] }),
    });
    await userEvent.click(await screen.findByTestId('remote-session-indicator'));
    expect(screen.getByText('No device named yet.')).toBeInTheDocument();
  });
});
