// @vitest-environment jsdom
/**
 * What the beacon opens — and, more importantly, what it does NOT open.
 *
 * The ordering cases are the design decision worth pinning: a desktop reader
 * has a phone in their other hand and wants the code, a phone reader IS the
 * other device and wants the link. Everything else here is restraint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { resetRemoteAccessStore, type TunnelReport } from '@/layers/entities/tunnel';

const isMobile = vi.hoisted(() => ({ current: false }));
vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({
  useIsMobile: () => isMobile.current,
}));

vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}));

import { RemoteAccessPanel } from '../ui/RemoteAccessPanel';

const connectedTunnel = {
  enabled: true,
  connected: true,
  isRunning: true,
  url: 'https://calm-otter.ngrok.app',
  port: 4242,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: true,
  domain: null,
} as unknown as TunnelReport;

function renderPanel(onClose = vi.fn(), tunnel: Partial<TunnelReport> = {}) {
  const transport: Transport = createMockTransport({
    getConfig: vi.fn(() =>
      Promise.resolve({ tunnel: { ...connectedTunnel, ...tunnel } } as unknown as ServerConfig)
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
  render(<RemoteAccessPanel onClose={onClose} />, { wrapper: Wrapper });
  return { transport, onClose };
}

/** True when `first` comes before `second` in the document. */
function comesBefore(first: HTMLElement, second: HTMLElement): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRemoteAccessStore();
  isMobile.current = false;
  useAppStore.setState({ remoteAccessOpen: false, remoteAccessBeaconOpen: true });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => cleanup());

describe('the panel', () => {
  it('says what is true and shows the address', async () => {
    renderPanel();

    await waitFor(() => expect(screen.getByText('Remote access is on')).toBeInTheDocument());
    expect(screen.getByTestId('qr-code')).toHaveTextContent('https://calm-otter.ngrok.app');
    expect(screen.getByTestId('remote-access-link')).toHaveTextContent(
      'https://calm-otter.ngrok.app'
    );
  });

  it('leads with the QR code on a desktop — the phone is in your other hand', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('remote-access-qr')).toBeInTheDocument());

    expect(
      comesBefore(screen.getByTestId('remote-access-qr'), screen.getByTestId('remote-access-link'))
    ).toBe(true);
  });

  it('leads with the link on a phone — you ARE the other device', async () => {
    isMobile.current = true;
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('remote-access-link')).toBeInTheDocument());

    expect(
      comesBefore(screen.getByTestId('remote-access-link'), screen.getByTestId('remote-access-qr'))
    ).toBe(true);
  });

  it('morphs the copy button to a check once the address is on the clipboard', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: /copy link/i })).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /copy link/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://calm-otter.ngrok.app');
  });

  it('turns remote access off from here', async () => {
    const { transport } = renderPanel();
    vi.mocked(transport.stopTunnel).mockResolvedValue(undefined);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Remote access' })).toBeChecked()
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Remote access' }));

    await waitFor(() => expect(transport.stopTunnel).toHaveBeenCalledTimes(1));
  });

  it('hands over to the full dialog, and gets out of its way', async () => {
    const onClose = vi.fn();
    renderPanel(onClose);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage…' })).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Manage…' }));

    expect(onClose).toHaveBeenCalled();
    expect(useAppStore.getState().remoteAccessOpen).toBe(true);
  });

  it('says why a refused stop failed, where the switch that failed is', async () => {
    const { transport } = renderPanel();
    vi.mocked(transport.stopTunnel).mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:4242'));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Remote access' })).toBeChecked()
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Remote access' }));

    const error = await screen.findByTestId('remote-access-panel-error');
    expect(error).toHaveTextContent("Couldn't reach your DorkOS server. Make sure it's running.");
    expect(error).toHaveAttribute('role', 'alert');
    // Remote access is still on: the panel is not claiming the stop worked.
    expect(screen.getByRole('switch', { name: 'Remote access' })).toBeChecked();
  });

  it('names the switch with the words next to it (WCAG 2.5.3)', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('remote-access-panel')).toBeInTheDocument());

    // The visible label and the accessible name are the same words, so a voice
    // user saying what they see actually hits the control — and they are the
    // ROW's words too, one vocabulary for one switch.
    const toggle = screen.getByRole('switch', { name: 'Remote access' });
    const label = toggle.parentElement?.querySelector('span');
    expect(label).toHaveTextContent('Remote access');
  });

  it('draws one heading on a phone, and it carries the state', async () => {
    // The drawer supplies its own title there (`RemoteAccessBeacon` passes the
    // same sentence), so a second visible heading inside the sheet would be two.
    isMobile.current = true;
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('remote-access-panel')).toBeInTheDocument());

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('draws its own heading on a desktop, where no drawer title exists', async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Remote access is on' })).toBeInTheDocument()
    );
  });

  it('carries nothing a glance does not need', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('remote-access-panel')).toBeInTheDocument());

    // Latency, the custom domain and the ngrok token all belong to the dialog,
    // one press away under "Manage…". A flyout that grew them would stop being
    // a glance.
    const text = screen.getByTestId('remote-access-panel').textContent ?? '';
    expect(text).not.toMatch(/latency|ms\b|token|domain|ngrok\.com/i);
  });

  it('waits calmly, without an address it does not have yet', async () => {
    renderPanel(vi.fn(), { connected: false, isRunning: true, url: null });

    await waitFor(() => expect(screen.getByText('Reconnecting…')).toBeInTheDocument());
    expect(screen.queryByTestId('remote-access-qr')).not.toBeInTheDocument();
    expect(screen.queryByTestId('remote-access-link')).not.toBeInTheDocument();
    expect(
      screen.getByText('Opening a secure tunnel. Your link appears here as soon as it is ready.')
    ).toBeInTheDocument();
  });
});
