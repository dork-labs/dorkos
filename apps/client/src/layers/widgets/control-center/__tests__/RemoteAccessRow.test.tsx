// @vitest-environment jsdom
/**
 * The Control Center's Remote-access row, in every state it can reach.
 *
 * Driven through the real shared model over a mock transport: the states the
 * SERVER can put it in come from what `GET /api/config` answers, and the three
 * that exist only on this side (`starting`, `stopping`, `error`) are produced
 * by the store's own actions — the same way an action produces them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import {
  resetRemoteAccessStore,
  useRemoteAccessStore,
  type TunnelReport,
} from '@/layers/entities/tunnel';
import { RemoteAccessRow } from '../ui/RemoteAccessRow';

const baseTunnel = {
  enabled: false,
  connected: false,
  isRunning: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: true,
  domain: null,
} as unknown as TunnelReport;

function renderRow(tunnel: Partial<TunnelReport> = {}) {
  const transport: Transport = createMockTransport({
    getConfig: vi.fn(() =>
      Promise.resolve({ tunnel: { ...baseTunnel, ...tunnel } } as unknown as ServerConfig)
    ),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  render(<RemoteAccessRow />, { wrapper: Wrapper });
  return { transport };
}

/** The row's description line, whatever it currently says. */
function description() {
  return screen.getByTestId('remote-access-row-description');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRemoteAccessStore();
  useAppStore.setState({ remoteAccessOpen: false, controlCenterOpen: true });
});

afterEach(() => cleanup());

describe('nothing set up yet', () => {
  it('offers the one-time setup rather than a tunnel', async () => {
    renderRow({ tokenConfigured: false });

    await waitFor(() =>
      expect(description()).toHaveTextContent('Use DorkOS from your phone. One-time setup.')
    );
    expect(screen.getByRole('switch', { name: 'Remote access' })).not.toBeChecked();
  });

  it('opens the Remote Access dialog instead of flipping, and gets out of its way', async () => {
    const { transport } = renderRow({ tokenConfigured: false });
    await waitFor(() =>
      expect(description()).toHaveTextContent('Use DorkOS from your phone. One-time setup.')
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Remote access' }));

    // There is nothing for a switch to turn on without an ngrok token, so it
    // must not pretend otherwise.
    expect(transport.startTunnel).not.toHaveBeenCalled();
    expect(useAppStore.getState().remoteAccessOpen).toBe(true);
    // A dialog under an open flyout is a dialog you have to dismiss something
    // to reach.
    expect(useAppStore.getState().controlCenterOpen).toBe(false);
    expect(screen.getByRole('switch', { name: 'Remote access' })).not.toBeChecked();
  });
});

describe('set up and off', () => {
  it('says what turning it on would do', async () => {
    renderRow();
    await waitFor(() =>
      expect(description()).toHaveTextContent('Use DorkOS from your phone or another computer.')
    );
  });

  it('starts the tunnel inline', async () => {
    const { transport } = renderRow();
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });
    // Until the config read answers, "no token saved" is a placeholder rather
    // than a fact, and the switch is held — so wait for the real answer.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Remote access' })).not.toBeDisabled()
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Remote access' }));

    await waitFor(() => expect(transport.startTunnel).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().remoteAccessOpen).toBe(false);
  });
});

describe('connecting', () => {
  it('says so, breathes, and holds the switch still', async () => {
    renderRow();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Remote access' })).not.toBeDisabled()
    );

    act(() => useRemoteAccessStore.getState().beginStart());

    expect(description()).toHaveTextContent('Connecting…');
    // Opacity-only, and `motion-safe` so a reader who asked for less motion
    // still gets the word.
    expect(description().className).toContain('motion-safe:animate-tasks');
    expect(screen.getByRole('switch', { name: 'Remote access' })).toBeDisabled();
  });
});

describe('on', () => {
  it('names the host and nothing else — the beacon owns the address', async () => {
    renderRow({ connected: true, isRunning: true, url: 'https://calm-otter.ngrok.app' });

    await waitFor(() => expect(description()).toHaveTextContent('On · calm-otter.ngrok.app'));
    expect(screen.getByRole('switch', { name: 'Remote access' })).toBeChecked();
    // No scheme, and no copyable URL: two places offering the same link is how
    // one of them goes stale.
    expect(description().textContent).not.toContain('https://');
  });

  it('turns off inline', async () => {
    const { transport } = renderRow({
      connected: true,
      isRunning: true,
      url: 'https://calm-otter.ngrok.app',
    });
    vi.mocked(transport.stopTunnel).mockResolvedValue(undefined);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Remote access' })).toBeChecked()
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Remote access' }));

    await waitFor(() => expect(transport.stopTunnel).toHaveBeenCalledTimes(1));
  });
});

describe('reconnecting', () => {
  it('stays visually on, with a quiet note', async () => {
    renderRow({ connected: false, isRunning: true, url: 'https://calm-otter.ngrok.app' });

    await waitFor(() =>
      expect(description()).toHaveTextContent('On · calm-otter.ngrok.app · reconnecting…')
    );
    // Still on: saying "off" would tell somebody their phone had lost the
    // address when it had not.
    expect(screen.getByRole('switch', { name: 'Remote access' })).toBeChecked();
    // And still usable — turning it off is the way out of a reconnect loop.
    expect(screen.getByRole('switch', { name: 'Remote access' })).not.toBeDisabled();
  });
});

describe('a start that failed', () => {
  it('says the short reason and offers a way to the full one', async () => {
    renderRow();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Remote access' })).not.toBeDisabled()
    );

    act(() => useRemoteAccessStore.getState().failStart('ERR_NGROK_105 bad auth'));

    // The same sentence the dialog shows, from the same map — not the raw
    // ngrok string.
    expect(description()).toHaveTextContent('Check your auth token at dashboard.ngrok.com');

    fireEvent.click(screen.getByRole('button', { name: 'Fix…' }));

    expect(useAppStore.getState().remoteAccessOpen).toBe(true);
    expect(useAppStore.getState().controlCenterOpen).toBe(false);
  });

  it('leaves the switch off and usable, so pressing it retries', async () => {
    const { transport } = renderRow();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Remote access' })).toBeDefined()
    );
    act(() => useRemoteAccessStore.getState().failStart('ngrok exploded'));

    const toggle = screen.getByRole('switch', { name: 'Remote access' });
    expect(toggle).not.toBeChecked();
    expect(toggle).not.toBeDisabled();

    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });
    fireEvent.click(toggle);

    await waitFor(() => expect(transport.startTunnel).toHaveBeenCalledTimes(1));
  });
});
