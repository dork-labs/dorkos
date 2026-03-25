// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { PasscodeGateWrapper } from '../ui/PasscodeGateWrapper';

// Mock PasscodeGate to avoid pulling in InputOTP (which requires ResizeObserver/
// document.elementFromPoint not available in jsdom). The wrapper tests only need
// to verify *whether* the gate is shown, not its internal rendering.
vi.mock('../ui/PasscodeGate', () => ({
  PasscodeGate: ({ onSuccess }: { onSuccess: () => void }) => (
    <div data-testid="passcode-gate">
      <button onClick={onSuccess}>Unlock</button>
    </div>
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
  vi.clearAllMocks();
  // Reset hostname back to localhost after each test
  Object.defineProperty(window, 'location', {
    value: { ...window.location, hostname: 'localhost' },
    writable: true,
  });
});

function createWrapper(transport = createMockTransport()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function setHostname(hostname: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, hostname },
    writable: true,
  });
}

describe('PasscodeGateWrapper', () => {
  it('renders children immediately when hostname is localhost', async () => {
    setHostname('localhost');
    const transport = createMockTransport();

    render(
      <PasscodeGateWrapper>
        <div data-testid="child-content">App content</div>
      </PasscodeGateWrapper>,
      { wrapper: createWrapper(transport) }
    );

    await waitFor(() => {
      expect(screen.getByTestId('child-content')).toBeDefined();
    });
    expect(transport.checkTunnelSession).not.toHaveBeenCalled();
  });

  it('renders children immediately when hostname is 127.0.0.1', async () => {
    setHostname('127.0.0.1');
    const transport = createMockTransport();

    render(
      <PasscodeGateWrapper>
        <div data-testid="child-content">App content</div>
      </PasscodeGateWrapper>,
      { wrapper: createWrapper(transport) }
    );

    await waitFor(() => {
      expect(screen.getByTestId('child-content')).toBeDefined();
    });
    expect(transport.checkTunnelSession).not.toHaveBeenCalled();
  });

  it('calls checkTunnelSession when hostname is not localhost', async () => {
    setHostname('abc123.ngrok-free.app');
    const transport = createMockTransport({
      checkTunnelSession: vi
        .fn()
        .mockResolvedValue({ authenticated: false, passcodeRequired: false }),
    });

    render(
      <PasscodeGateWrapper>
        <div data-testid="child-content">App content</div>
      </PasscodeGateWrapper>,
      { wrapper: createWrapper(transport) }
    );

    await waitFor(() => {
      expect(transport.checkTunnelSession).toHaveBeenCalledTimes(1);
    });
  });

  it('shows PasscodeGate when session is not authenticated and passcode is required', async () => {
    setHostname('abc123.ngrok-free.app');
    const transport = createMockTransport({
      checkTunnelSession: vi
        .fn()
        .mockResolvedValue({ authenticated: false, passcodeRequired: true }),
    });

    render(
      <PasscodeGateWrapper>
        <div data-testid="child-content">App content</div>
      </PasscodeGateWrapper>,
      { wrapper: createWrapper(transport) }
    );

    await waitFor(() => {
      expect(screen.getByTestId('passcode-gate')).toBeDefined();
    });
    expect(screen.queryByTestId('child-content')).toBeNull();
  });

  it('renders children when session is authenticated', async () => {
    setHostname('abc123.ngrok-free.app');
    const transport = createMockTransport({
      checkTunnelSession: vi
        .fn()
        .mockResolvedValue({ authenticated: true, passcodeRequired: true }),
    });

    render(
      <PasscodeGateWrapper>
        <div data-testid="child-content">App content</div>
      </PasscodeGateWrapper>,
      { wrapper: createWrapper(transport) }
    );

    await waitFor(() => {
      expect(screen.getByTestId('child-content')).toBeDefined();
    });
  });

  it('renders children when passcode is not required', async () => {
    setHostname('abc123.ngrok-free.app');
    const transport = createMockTransport({
      checkTunnelSession: vi
        .fn()
        .mockResolvedValue({ authenticated: false, passcodeRequired: false }),
    });

    render(
      <PasscodeGateWrapper>
        <div data-testid="child-content">App content</div>
      </PasscodeGateWrapper>,
      { wrapper: createWrapper(transport) }
    );

    await waitFor(() => {
      expect(screen.getByTestId('child-content')).toBeDefined();
    });
  });

  it('renders children (fail-open) when checkTunnelSession rejects', async () => {
    setHostname('abc123.ngrok-free.app');
    const transport = createMockTransport({
      checkTunnelSession: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    render(
      <PasscodeGateWrapper>
        <div data-testid="child-content">App content</div>
      </PasscodeGateWrapper>,
      { wrapper: createWrapper(transport) }
    );

    await waitFor(() => {
      expect(screen.getByTestId('child-content')).toBeDefined();
    });
  });
});
