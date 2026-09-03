// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TunnelDialog } from '../ui/TunnelDialog';

// Mock useIsMobile to always return false (desktop dialog)
vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

// Mock useSessionId
vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => [null, vi.fn()],
}));

// Mock sonner
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Mock Radix dialog portal to render inline
vi.mock('@radix-ui/react-dialog', async () => {
  const actual =
    await vi.importActual<typeof import('@radix-ui/react-dialog')>('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Mock QRCode to avoid canvas rendering issues
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
  url: null,
  port: null as number | null,
  startedAt: null as string | null,
  authEnabled: false,
  tokenConfigured: true,
  domain: null as string | null,
};

function createTunnelTransport(tunnelOverrides?: Partial<typeof baseTunnel>): Transport {
  return createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      latestVersion: null,
      port: 4242,
      uptime: 0,
      workingDirectory: '/tmp',
      nodeVersion: 'v20.0.0',
      claudeCliPath: null,
      tunnel: { ...baseTunnel, ...tunnelOverrides },
    }),
  });
}

function createWrapper(transport?: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const t = transport || createTunnelTransport();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={t}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('TunnelDialog', () => {
  it('renders hero toggle card when token is configured', async () => {
    render(<TunnelDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(screen.getByText('Enable remote access')).toBeDefined();
      expect(screen.getByText('Open a secure tunnel via ngrok')).toBeDefined();
    });
  });

  it('renders "Remote Access" title when open', () => {
    render(<TunnelDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('Remote Access')).toBeDefined();
  });

  it('shows landing view when tokenConfigured is false', async () => {
    const transport = createTunnelTransport({ tokenConfigured: false });
    render(<TunnelDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => {
      expect(screen.getByTestId('tunnel-landing')).toBeDefined();
    });
  });

  it('shows settings view when tokenConfigured is true', async () => {
    const transport = createTunnelTransport({ tokenConfigured: true });
    render(<TunnelDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => {
      expect(screen.getByTestId('tunnel-settings')).toBeDefined();
    });
  });

  it('does not show setup view when tokenConfigured is true', async () => {
    const transport = createTunnelTransport({ tokenConfigured: true });
    render(<TunnelDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => {
      expect(screen.queryByTestId('tunnel-setup')).toBeNull();
    });
  });

  it('retries the start when Try again is pressed', async () => {
    const user = userEvent.setup();
    const transport = createTunnelTransport({ tokenConfigured: true });
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));
    render(<TunnelDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });

    // Fail a start, so the error view is on screen with its button.
    await waitFor(() => expect(screen.getByRole('switch')).toBeDefined());
    await user.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByTestId('tunnel-error')).toBeDefined());
    expect(vi.mocked(transport.startTunnel)).toHaveBeenCalledTimes(1);

    // The button has to actually try again. Wired to a handler that only reset
    // the state, it cleared the message and left the person to find the switch —
    // and no assertion on the machine alone can see that, because the wiring is
    // in the dialog.
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(vi.mocked(transport.startTunnel)).toHaveBeenCalledTimes(2));
  });

  it('does not render content when closed', () => {
    render(<TunnelDialog open={false} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('Enable remote access')).toBeNull();
  });
});
