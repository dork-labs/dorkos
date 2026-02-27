// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TunnelItem } from '../ui/TunnelItem';
import type { ServerConfig } from '@dorkos/shared/types';

// Mock useIsMobile to always return false (desktop dialog)
vi.mock('@/layers/shared/model/use-is-mobile', () => ({
  useIsMobile: () => false,
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

function createWrapper(transport?: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const t = transport || createMockTransport();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={t}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function makeTunnel(overrides?: Partial<ServerConfig['tunnel']>): ServerConfig['tunnel'] {
  return {
    enabled: false,
    connected: false,
    url: null,
    authEnabled: false,
    tokenConfigured: true,
    ...overrides,
  };
}

describe('TunnelItem', () => {
  it('renders hostname when connected', () => {
    render(
      <TunnelItem tunnel={makeTunnel({ enabled: true, connected: true, url: 'https://abc123.ngrok-free.app' })} />,
      { wrapper: createWrapper() }
    );
    expect(screen.getByText('abc123.ngrok-free.app')).toBeDefined();
  });

  it('renders "Remote" text when disconnected', () => {
    render(<TunnelItem tunnel={makeTunnel()} />, { wrapper: createWrapper() });
    expect(screen.getByText('Remote')).toBeDefined();
  });

  it('does not show hostname when disconnected', () => {
    render(<TunnelItem tunnel={makeTunnel()} />, { wrapper: createWrapper() });
    expect(screen.queryByText(/ngrok/)).toBeNull();
  });

  it('has correct aria-label when connected', () => {
    render(
      <TunnelItem tunnel={makeTunnel({ enabled: true, connected: true, url: 'https://abc123.ngrok-free.app' })} />,
      { wrapper: createWrapper() }
    );
    expect(screen.getByLabelText('Remote connected: abc123.ngrok-free.app')).toBeDefined();
  });

  it('has correct aria-label when disconnected', () => {
    render(<TunnelItem tunnel={makeTunnel()} />, { wrapper: createWrapper() });
    expect(screen.getByLabelText('Remote disconnected')).toBeDefined();
  });

  it('opens dialog on click', () => {
    render(<TunnelItem tunnel={makeTunnel()} />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Enable remote access')).toBeDefined();
  });
});
