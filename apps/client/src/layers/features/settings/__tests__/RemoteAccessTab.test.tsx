// @vitest-environment jsdom
/**
 * Remote Access as a settings PANEL rather than a dialog over a dialog
 * (DOR-1758).
 *
 * The old sidebar button looked like a tab, sat in the list of tabs, and opened
 * a second modal — with the drill-in chevron every tab row has on a phone, where
 * the recovery gesture is worst. What this suite pins is that the same body now
 * renders inline, with no dialog of its own.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RemoteAccessTab } from '../ui/RemoteAccessTab';

vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => [null, vi.fn()],
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
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

afterEach(() => {
  cleanup();
});

const baseTunnel = {
  enabled: false,
  connected: false,
  url: null as string | null,
  port: null as number | null,
  startedAt: null as string | null,
  authEnabled: false,
  tokenConfigured: true,
  domain: null as string | null,
};

function createWrapper(tunnelOverrides?: Partial<typeof baseTunnel>) {
  const transport: Transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/tmp',
      nodeVersion: 'v22.0.0',
      tunnel: { ...baseTunnel, ...tunnelOverrides },
    }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('RemoteAccessTab', () => {
  it('renders the tunnel controls inline, with no dialog of its own', async () => {
    render(<RemoteAccessTab />, { wrapper: createWrapper() });

    expect(await screen.findByRole('switch', { name: 'Remote access' })).toBeInTheDocument();
    expect(await screen.findByText('Enable remote access')).toBeInTheDocument();
    // The whole point of the move: a tab swaps the panel, it does not stack a
    // second modal on the settings modal.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers the setup path when this machine has no ngrok token yet', async () => {
    render(<RemoteAccessTab />, { wrapper: createWrapper({ tokenConfigured: false }) });

    expect(await screen.findByRole('button', { name: /get started/i })).toBeInTheDocument();
    // One headline under the illustration, not the same sentence twice.
    expect(screen.getAllByText('Access DorkOS from any device')).toHaveLength(1);
  });
});

/** The tab over a config whose Remote Access switch reads `enabled`. */
function renderWithSwitch(
  enabled: boolean | undefined,
  tunnelOverrides?: Partial<typeof baseTunnel>
) {
  let remote = enabled;
  const updateConfig = vi.fn(async (patch: Record<string, unknown>) => {
    remote = (patch.remoteAccess as { enabled: boolean }).enabled;
  });
  const transport: Transport = createMockTransport({
    getConfig: vi.fn().mockImplementation(async () => ({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/tmp',
      nodeVersion: 'v22.0.0',
      tunnel: { ...baseTunnel, ...tunnelOverrides },
      ...(remote === undefined ? {} : { remoteAccess: { enabled: remote } }),
    })),
    updateConfig,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RemoteAccessTab />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { updateConfig };
}

describe('RemoteAccessTab, the Remote access switch (DOR-3650)', () => {
  const masterSwitch = () => screen.findByRole('switch', { name: 'Remote access' });

  it('shows it on, at the top, with what on means', async () => {
    renderWithSwitch(true);

    expect(await masterSwitch()).toBeChecked();
    expect(
      screen.getByText('Your other devices can reach DorkOS with an API key.')
    ).toBeInTheDocument();
    expect(await screen.findByText('Enable remote access')).toBeInTheDocument();
  });

  it('reads an older server with no switch as on', async () => {
    renderWithSwitch(undefined);
    expect(await masterSwitch()).toBeChecked();
  });

  it('shows it off, and hides the ways in while it is off', async () => {
    renderWithSwitch(false);

    expect(await masterSwitch()).not.toBeChecked();
    expect(screen.getByText('Off. Only this computer can reach DorkOS.')).toBeInTheDocument();
    expect(screen.queryByText('Enable remote access')).not.toBeInTheDocument();
  });

  it('turns it off with no confirm, and says devices lose access on their next request', async () => {
    const { updateConfig } = renderWithSwitch(true);

    fireEvent.click(await masterSwitch());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ remoteAccess: { enabled: false } })
    );
    expect(
      await screen.findByText('Off. Devices using it lose access on their next request.')
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Enable remote access')).not.toBeInTheDocument());
  });

  it('turns it on with the switch alone when a way in is set up', async () => {
    const { updateConfig } = renderWithSwitch(false);

    fireEvent.click(await masterSwitch());

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ remoteAccess: { enabled: true } })
    );
    expect(await screen.findByText('Enable remote access')).toBeInTheDocument();
  });

  it('opens the existing setup when turning it on with nothing set up', async () => {
    renderWithSwitch(false, { tokenConfigured: false });

    fireEvent.click(await masterSwitch());

    expect(await screen.findByPlaceholderText('Paste your ngrok auth token')).toBeInTheDocument();
  });
});
