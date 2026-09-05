// @vitest-environment jsdom
/**
 * The beacon shell: when it exists at all, what it says, and how much it moves.
 *
 * The panel is stubbed so this exercises the glyph and its visibility rule —
 * the panel's own contents have their own test.
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
import { setPrefersReducedMotion } from '@/test-setup';
import {
  resetRemoteAccessStore,
  useRemoteAccessStore,
  type TunnelReport,
} from '@/layers/entities/tunnel';

vi.mock('../ui/RemoteAccessPanel', () => ({
  RemoteAccessPanel: () => <div data-testid="beacon-panel" />,
}));

import { RemoteAccessBeacon } from '../ui/RemoteAccessBeacon';

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

function renderBeacon(tunnel: Partial<TunnelReport> = {}) {
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
  render(<RemoteAccessBeacon />, { wrapper: Wrapper });
  return { transport };
}

const beacon = () => screen.queryByTestId('remote-access-beacon');

beforeEach(() => {
  vi.clearAllMocks();
  resetRemoteAccessStore();
  useAppStore.setState({ remoteAccessBeaconOpen: false, remoteAccessOpen: false });
});

afterEach(() => cleanup());

describe('when it exists at all', () => {
  it('draws nothing while remote access is off', async () => {
    renderBeacon();
    // Wait for the config read so this is a settled "off", not a pre-answer one.
    await waitFor(() => expect(useRemoteAccessStore.getState().tokenConfigured).toBe(true));
    expect(beacon()).not.toBeInTheDocument();
  });

  it('draws nothing after a failed start either', async () => {
    renderBeacon();
    await waitFor(() => expect(useRemoteAccessStore.getState().tokenConfigured).toBe(true));

    act(() => useRemoteAccessStore.getState().failStart('ngrok exploded'));

    // A failure is not a tunnel. The Control Center row reports it; the top bar
    // stays clean.
    expect(beacon()).not.toBeInTheDocument();
  });

  it('appears while connecting, on, reconnecting, and turning off', async () => {
    renderBeacon();
    await waitFor(() => expect(useRemoteAccessStore.getState().tokenConfigured).toBe(true));

    act(() => useRemoteAccessStore.getState().beginStart());
    expect(beacon()).toBeInTheDocument();

    act(() => useRemoteAccessStore.getState().settleStart('https://calm-otter.ngrok.app'));
    expect(beacon()).toBeInTheDocument();

    act(() => useRemoteAccessStore.getState().convergeStart(null));
    expect(beacon()).toBeInTheDocument();

    // Still there while the stop is in flight. Vanishing on the press would
    // take the flyout the person is standing in with it, and bring it back if
    // the stop were refused.
    act(() => useRemoteAccessStore.getState().beginStop());
    expect(beacon()).toBeInTheDocument();

    act(() => useRemoteAccessStore.getState().settleStop());
    expect(beacon()).not.toBeInTheDocument();
  });
});

describe('what it says', () => {
  it('names the host and the offer in its accessible name', async () => {
    renderBeacon({ connected: true, isRunning: true, url: 'https://calm-otter.ngrok.app' });

    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Remote access is on at calm-otter.ngrok.app — show link and QR',
        })
      ).toBeInTheDocument()
    );
  });

  it('does not offer a link it does not have yet', async () => {
    renderBeacon();
    await waitFor(() => expect(useRemoteAccessStore.getState().tokenConfigured).toBe(true));

    act(() => useRemoteAccessStore.getState().beginStart());

    // An icon-only control has to say what pressing it does — and while the
    // tunnel is still coming up, it does not yet offer a link or a code.
    expect(
      screen.getByRole('button', { name: 'Remote access is connecting — open remote access' })
    ).toBeInTheDocument();
  });

  it('keeps a live region mounted so its arrival is announced', async () => {
    renderBeacon();
    // Present and empty while nothing is running: an `aria-live` region has to
    // exist BEFORE its content changes for assistive tech to read it.
    const region = screen.getByTestId('remote-access-announcement');
    expect(region).toHaveAttribute('role', 'status');
    await waitFor(() => expect(useRemoteAccessStore.getState().tokenConfigured).toBe(true));
    expect(region).toHaveTextContent('');

    act(() => useRemoteAccessStore.getState().settleStart('https://calm-otter.ngrok.app'));

    expect(screen.getByTestId('remote-access-announcement')).toHaveTextContent(
      'Remote access is on at calm-otter.ngrok.app'
    );
  });

  it('wears green when connected and amber while it is not settled', async () => {
    renderBeacon({ connected: true, isRunning: true, url: 'https://calm-otter.ngrok.app' });
    await waitFor(() => expect(beacon()).toBeInTheDocument());
    expect(screen.getByTestId('remote-access-beacon-dot').className).toContain('bg-status-success');

    act(() => useRemoteAccessStore.getState().convergeStart(null));

    expect(screen.getByTestId('remote-access-beacon-dot').className).toContain(
      'bg-status-warning-dot'
    );
    // Dimmed, not red: the tunnel is still on, just not at its best.
    expect(beacon()?.className).toContain('opacity-70');
  });
});

describe('how much it moves', () => {
  it('does not ripple for a tunnel that was already up', async () => {
    renderBeacon({ connected: true, isRunning: true, url: 'https://calm-otter.ngrok.app' });
    await waitFor(() => expect(beacon()).toBeInTheDocument());

    // Opening the app onto remote access you turned on yesterday is not an
    // event, and announcing it would be the same mistake the status toasts
    // spent a release making.
    expect(screen.queryByTestId('remote-access-beacon-ripple')).not.toBeInTheDocument();
  });

  it('ripples once when a tunnel comes up', async () => {
    renderBeacon();
    await waitFor(() => expect(useRemoteAccessStore.getState().tokenConfigured).toBe(true));

    act(() => useRemoteAccessStore.getState().beginStart());
    expect(screen.queryByTestId('remote-access-beacon-ripple')).not.toBeInTheDocument();

    act(() => useRemoteAccessStore.getState().settleStart('https://calm-otter.ngrok.app'));

    const ripple = screen.getByTestId('remote-access-beacon-ripple');
    // A single iteration, held at its transparent end frame — a steady tunnel
    // is silent.
    expect(ripple.className).toContain('animate-beacon-ripple');
  });

  it('breathes while connecting and holds still once connected', async () => {
    renderBeacon();
    await waitFor(() => expect(useRemoteAccessStore.getState().tokenConfigured).toBe(true));

    act(() => useRemoteAccessStore.getState().beginStart());
    expect(beacon()?.innerHTML).toContain('motion-safe:animate-breath');

    act(() => useRemoteAccessStore.getState().settleStart('https://calm-otter.ngrok.app'));
    expect(beacon()?.innerHTML).not.toContain('animate-breath');
  });

  it('collapses every part of that under prefers-reduced-motion', async () => {
    setPrefersReducedMotion(true);
    renderBeacon();
    await waitFor(() => expect(useRemoteAccessStore.getState().tokenConfigured).toBe(true));

    act(() => useRemoteAccessStore.getState().settleStart('https://calm-otter.ngrok.app'));

    // The ripple is not rendered at all; the breath is `motion-safe:`, which
    // the media query removes.
    expect(screen.queryByTestId('remote-access-beacon-ripple')).not.toBeInTheDocument();
    expect(beacon()).toBeInTheDocument();
  });
});

describe('the flyout', () => {
  it('opens on click and is driven by the store flag both ways', async () => {
    renderBeacon({ connected: true, isRunning: true, url: 'https://calm-otter.ngrok.app' });
    await waitFor(() => expect(beacon()).toBeInTheDocument());
    expect(screen.queryByTestId('beacon-panel')).not.toBeInTheDocument();

    fireEvent.click(beacon()!);

    expect(screen.getByTestId('beacon-panel')).toBeInTheDocument();
    expect(useAppStore.getState().remoteAccessBeaconOpen).toBe(true);

    // The seam ⌘K's "Show QR code" uses.
    act(() => useAppStore.getState().setRemoteAccessBeaconOpen(false));
    expect(screen.queryByTestId('beacon-panel')).not.toBeInTheDocument();
    act(() => useAppStore.getState().setRemoteAccessBeaconOpen(true));
    expect(screen.getByTestId('beacon-panel')).toBeInTheDocument();
  });

  it('closes itself when the tunnel goes away under it', async () => {
    renderBeacon({ connected: true, isRunning: true, url: 'https://calm-otter.ngrok.app' });
    await waitFor(() => expect(beacon()).toBeInTheDocument());
    act(() => useAppStore.getState().setRemoteAccessBeaconOpen(true));
    expect(screen.getByTestId('beacon-panel')).toBeInTheDocument();

    act(() => useRemoteAccessStore.getState().settleStop());

    // Its own trigger is about to unmount; a flyout about a tunnel that has
    // gone is a flyout about nothing.
    await waitFor(() => expect(useAppStore.getState().remoteAccessBeaconOpen).toBe(false));
    expect(beacon()).not.toBeInTheDocument();
  });
});
