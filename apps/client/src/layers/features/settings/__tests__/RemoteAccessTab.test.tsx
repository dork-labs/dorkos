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
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TunnelMachineProvider } from '../model/tunnel-machine-provider';
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
      <TransportProvider transport={transport}>
        <TunnelMachineProvider>{children}</TunnelMachineProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('RemoteAccessTab', () => {
  it('renders the tunnel controls inline, with no dialog of its own', async () => {
    render(<RemoteAccessTab />, { wrapper: createWrapper() });

    expect(await screen.findByRole('switch')).toBeInTheDocument();
    expect(screen.getByText('Enable remote access')).toBeInTheDocument();
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
