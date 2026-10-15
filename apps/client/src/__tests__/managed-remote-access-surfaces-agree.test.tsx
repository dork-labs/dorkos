// @vitest-environment jsdom
/**
 * All four remote-access surfaces, mounted together over one managed report
 * (DOR-2086): Settings, the Control Center row, the beacon with its flyout, and
 * the command palette's rows.
 *
 * Each reads the one report through the shared store, and each acts through
 * the same selected-mode actions. This pins that they say the same thing about
 * every state, and that a change made on one reaches the other three. It lives
 * in the app layer because only the app may import a feature and two widgets
 * at once.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { RemoteAccessReport, ServerConfig } from '@dorkos/shared/types';
import { createMockTransport, createRemoteAccessReport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { resetRemoteAccessStore } from '@/layers/entities/tunnel';
import { TunnelDialog } from '@/layers/features/settings';
import { useRemoteAccessPaletteItems } from '@/layers/features/command-palette';
import { RemoteAccessRow } from '@/layers/widgets/control-center';
import { RemoteAccessBeacon } from '@/layers/widgets/remote-access';

vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessionId: () => [null, vi.fn()],
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

/** No ngrok token: anything that works here works through DorkOS alone. */
const NO_NGROK = {
  enabled: false,
  connected: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: false,
  domain: null,
};

/** The palette's rows, by label. */
function PaletteRows() {
  const items = useRemoteAccessPaletteItems();
  return (
    <ul data-testid="palette-rows">
      {items.map((item) => (
        <li key={item.id}>{item.label}</li>
      ))}
    </ul>
  );
}

/** Mount the four surfaces over one transport, the way the app shell does. */
function renderAllSurfaces(first: RemoteAccessReport) {
  let served = first;
  const transport = createMockTransport({
    getConfig: vi.fn(() => Promise.resolve({ tunnel: NO_NGROK } as unknown as ServerConfig)),
    getRemoteAccessReport: vi.fn(() => Promise.resolve(served)),
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
      <PaletteRows />
      <TunnelDialog open onOpenChange={vi.fn()} />
    </>,
    { wrapper: Wrapper }
  );
  /** What the server answers from the next read on. */
  const serverNowSays = (next: RemoteAccessReport) => {
    served = next;
  };
  return { transport, serverNowSays };
}

const rowDescription = () => screen.getByTestId('remote-access-row-description');
/**
 * The row's switch. `hidden: true` because the open dialog marks everything
 * outside it hidden from assistive tech, which a click in a test ignores.
 */
const rowSwitch = () => screen.getByRole('switch', { name: 'Remote access', hidden: true });
const beacon = () => screen.queryByTestId('remote-access-beacon');
const palette = () => screen.getByTestId('palette-rows');
const settings = () => screen.getByTestId('managed-status');

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

describe('one managed report, four surfaces', () => {
  it('closed for now: every surface is calm, and the address is offered everywhere', async () => {
    renderAllSurfaces(createRemoteAccessReport({ state: 'asleep' }));

    await waitFor(() =>
      expect(rowDescription()).toHaveTextContent('Closed for now · calm-otter.example.com')
    );
    expect(beacon()).toHaveAttribute(
      'aria-label',
      'Remote access is closed for now at calm-otter.example.com. Show link and QR code'
    );
    expect(within(settings()).getByText('Remote access is closed for now')).toBeInTheDocument();
    expect(within(palette()).getByText('Copy remote link')).toBeInTheDocument();
    expect(within(palette()).getByText('Turn remote access off')).toBeInTheDocument();
    // Neutral, never red or amber, on the two surfaces that draw a dot.
    expect(screen.getByTestId('remote-access-beacon-dot').className).toContain(
      'bg-muted-foreground/60'
    );
    expect(document.body.textContent).not.toMatch(/asleep|wake|reconnecting/i);
  });

  it('blocked: the reason on the row and in Settings; no beacon and no link', async () => {
    renderAllSurfaces(
      createRemoteAccessReport({
        state: 'blocked',
        url: undefined,
        reason: 'Setup did not finish. Start it again.',
      })
    );

    await waitFor(() =>
      expect(rowDescription()).toHaveTextContent('Setup did not finish. Start it again.')
    );
    expect(within(settings()).getByText('Setup did not finish. Start it again.')).toBeVisible();
    expect(beacon()).not.toBeInTheDocument();
    expect(within(palette()).queryByText('Copy remote link')).not.toBeInTheDocument();
    expect(within(palette()).getByText('Turn remote access off')).toBeInTheDocument();
  });

  it('DorkOS Cloud unreachable: the row and Settings both say so', async () => {
    renderAllSurfaces(
      createRemoteAccessReport({ state: 'open', cloudStale: true, availability: 'unavailable' })
    );

    await waitFor(() => expect(rowDescription()).toHaveTextContent('Can’t reach DorkOS Cloud'));
    expect(within(settings()).getByTestId('managed-status-stale')).toBeInTheDocument();
    expect(beacon()).toBeInTheDocument();
  });

  it('turned off from the row: DorkOS hears it, ngrok does not, and the rest follow', async () => {
    const { transport, serverNowSays } = renderAllSurfaces(createRemoteAccessReport());
    const off = createRemoteAccessReport({ mode: 'off', state: 'off', url: undefined });
    await waitFor(() => expect(beacon()).toBeInTheDocument());
    vi.mocked(transport.setRemoteAccessMode).mockResolvedValue(off);
    serverNowSays(off);
    fireEvent.click(rowSwitch());

    await waitFor(() => expect(transport.setRemoteAccessMode).toHaveBeenCalledWith('off'));
    expect(transport.stopTunnel).not.toHaveBeenCalled();
    await waitFor(() => expect(beacon()).not.toBeInTheDocument());
    // Still set up for DorkOS, with no ngrok token: on is one press away.
    expect(within(palette()).getByText('Turn remote access on')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked();
  });

  it('turned back on from the row: DorkOS again, never a bare ngrok start', async () => {
    const { transport, serverNowSays } = renderAllSurfaces(
      createRemoteAccessReport({ mode: 'off', state: 'off', url: undefined })
    );
    const on = createRemoteAccessReport({ state: 'asleep' });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked());
    vi.mocked(transport.setRemoteAccessMode).mockResolvedValue(on);
    serverNowSays(on);
    fireEvent.click(rowSwitch());

    await waitFor(() => expect(transport.setRemoteAccessMode).toHaveBeenCalledWith('managed'));
    expect(transport.startTunnel).not.toHaveBeenCalled();
    await waitFor(() => expect(beacon()).toBeInTheDocument());
    expect(screen.getByRole('radio', { name: 'DorkOS' })).toBeChecked();
  });
});
