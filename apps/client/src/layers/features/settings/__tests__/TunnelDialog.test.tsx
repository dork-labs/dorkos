// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TunnelDialog } from '../ui/TunnelDialog';

// Mock useIsMobile to always return false (desktop dialog)
vi.mock('@/layers/shared/model/use-is-mobile', () => ({
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

// Mock motion/react so AnimatePresence mode="wait" renders immediately in jsdom
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        return ({ children, ...rest }: Record<string, unknown>) => {
          const Tag = prop as keyof React.JSX.IntrinsicElements;
          // Filter out motion-specific props
          const htmlProps: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rest)) {
            if (
              ![
                'variants',
                'initial',
                'animate',
                'exit',
                'transition',
                'onAnimationComplete',
              ].includes(k)
            ) {
              htmlProps[k] = v;
            }
          }
          // @ts-expect-error — dynamic tag rendering for test mock
          return <Tag {...htmlProps}>{children}</Tag>;
        };
      },
    }
  ),
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
  passcodeEnabled: false,
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

  it('does not render content when closed', () => {
    render(<TunnelDialog open={false} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByText('Enable remote access')).toBeNull();
  });
});
