// @vitest-environment jsdom
/**
 * The two remote-access surfaces, mounted for real, side by side (DOR-1743).
 *
 * This is the property a per-surface `useState` machine cannot have, and the
 * one every model-level assertion misses: the Control Center's row and the
 * top-bar beacon are separate components in separate widget slices, and a
 * tunnel started from one has to be on in the other. Calling the same hook
 * twice inside one `renderHook` proves the hook is consistent with itself; only
 * mounting both components proves the SURFACES are.
 *
 * It lives in the app layer because that is the only place allowed to import
 * two widgets at once — which is also the only place that really does.
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
import { resetRemoteAccessStore } from '@/layers/entities/tunnel';
import { RemoteAccessRow } from '@/layers/widgets/control-center';
import { RemoteAccessBeacon } from '@/layers/widgets/remote-access';

vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}));

const OFF_TUNNEL = {
  enabled: false,
  connected: false,
  isRunning: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: true,
  domain: null,
};

/** Mount both surfaces over one transport, the way the app shell does. */
function renderBothSurfaces() {
  let served: Record<string, unknown> = { ...OFF_TUNNEL };
  const transport: Transport = createMockTransport({
    getConfig: vi.fn(() => Promise.resolve({ tunnel: served } as unknown as ServerConfig)),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  render(
    <>
      <RemoteAccessRow />
      <RemoteAccessBeacon />
    </>,
    { wrapper: Wrapper }
  );

  /** What the server will answer from the next read on — no refetch forced. */
  const serverNowSays = (next: Record<string, unknown>) => {
    served = { ...served, ...next };
  };

  return { transport, serverNowSays };
}

const rowSwitch = () => screen.getByRole('switch', { name: 'Remote access' });
const rowDescription = () => screen.getByTestId('remote-access-row-description');
const beacon = () => screen.queryByTestId('remote-access-beacon');

beforeEach(() => {
  vi.clearAllMocks();
  resetRemoteAccessStore();
  useAppStore.setState({
    remoteAccessOpen: false,
    remoteAccessBeaconOpen: false,
    controlCenterOpen: true,
  });
});

afterEach(() => cleanup());

describe('the Control Center row and the top-bar beacon', () => {
  it('start from the row and the beacon appears with the same address', async () => {
    const { transport, serverNowSays } = renderBothSurfaces();
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://calm-otter.ngrok.app' });
    serverNowSays({ connected: true, isRunning: true, url: 'https://calm-otter.ngrok.app' });

    await waitFor(() => expect(rowSwitch()).not.toBeDisabled());
    // Nothing in the top bar while remote access is off.
    expect(beacon()).not.toBeInTheDocument();

    fireEvent.click(rowSwitch());

    await waitFor(() => expect(beacon()).toBeInTheDocument());
    expect(rowDescription()).toHaveTextContent('On · calm-otter.ngrok.app');
    expect(rowSwitch()).toBeChecked();
    expect(beacon()).toHaveAttribute(
      'aria-label',
      'Remote access is on at calm-otter.ngrok.app — show link and QR'
    );
  });

  it('stop from the beacon flyout and the row follows', async () => {
    const { transport, serverNowSays } = renderBothSurfaces();
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://calm-otter.ngrok.app' });
    serverNowSays({ connected: true, isRunning: true, url: 'https://calm-otter.ngrok.app' });
    await waitFor(() => expect(rowSwitch()).not.toBeDisabled());
    fireEvent.click(rowSwitch());
    await waitFor(() => expect(beacon()).toBeInTheDocument());

    // Turn it off from the OTHER surface entirely.
    vi.mocked(transport.stopTunnel).mockResolvedValue(undefined);
    serverNowSays({ connected: false, isRunning: false, url: null });
    fireEvent.click(beacon()!);
    const panelSwitch = await screen.findByTestId('remote-access-panel');
    fireEvent.click(panelSwitch.querySelector('[role="switch"]') as HTMLElement);

    await waitFor(() => expect(transport.stopTunnel).toHaveBeenCalledTimes(1));
    // The row is a different component in a different widget slice, and it did
    // not hear about this from the beacon — it reads the same model.
    await waitFor(() => expect(rowSwitch()).not.toBeChecked());
    expect(rowDescription()).toHaveTextContent('Use DorkOS from your phone or another computer.');
    expect(beacon()).not.toBeInTheDocument();
  });

  it('a refused stop leaves BOTH surfaces on, and both say why', async () => {
    // The #1458 symptom class on the new surfaces: the stop fails, remote
    // access is still up, and the reason has to be visible rather than swallowed
    // behind a state that never becomes `error`.
    const { transport, serverNowSays } = renderBothSurfaces();
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://calm-otter.ngrok.app' });
    serverNowSays({ connected: true, isRunning: true, url: 'https://calm-otter.ngrok.app' });
    await waitFor(() => expect(rowSwitch()).not.toBeDisabled());
    fireEvent.click(rowSwitch());
    await waitFor(() => expect(beacon()).toBeInTheDocument());

    vi.mocked(transport.stopTunnel).mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:4242'));
    fireEvent.click(beacon()!);
    const panel = await screen.findByTestId('remote-access-panel');
    fireEvent.click(panel.querySelector('[role="switch"]') as HTMLElement);

    // The panel says it, where the switch that failed is.
    const panelError = await screen.findByTestId('remote-access-panel-error');
    expect(panelError).toHaveTextContent(
      "Couldn't reach your DorkOS server. Make sure it's running."
    );
    // And so does the row, which is where somebody who closed the flyout looks.
    expect(rowDescription()).toHaveTextContent(
      "Couldn't reach your DorkOS server. Make sure it's running."
    );
    // Remote access is still on — the stop did not happen.
    expect(rowSwitch()).toBeChecked();
    expect(beacon()).toBeInTheDocument();
  });
});
