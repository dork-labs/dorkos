// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { PasscodeGate } from '../ui/PasscodeGate';

vi.mock('@dorkos/icons/logos', () => ({
  DorkLogo: () => <div data-testid="dork-logo" />,
}));

// Capture the onComplete callback so tests can trigger it directly.
// input-otp relies on ResizeObserver and document.elementFromPoint which
// are absent in jsdom — mocking the module sidesteps those browser APIs.
let capturedOnComplete: ((value: string) => void) | undefined;
let capturedDisabled = false;
let capturedValue = '';

vi.mock('@/layers/shared/ui/input-otp', () => ({
  InputOTP: ({
    onComplete,
    disabled,
    value,
    onChange,
    children,
  }: {
    onComplete?: (value: string) => void;
    disabled?: boolean;
    value?: string;
    onChange?: (value: string) => void;
    maxLength?: number;
    children?: React.ReactNode;
  }) => {
    capturedOnComplete = onComplete;
    capturedDisabled = disabled ?? false;
    capturedValue = value ?? '';
    return (
      <div data-testid="input-otp" data-disabled={disabled} data-value={value}>
        <input
          value={value ?? ''}
          onChange={(e) => onChange?.(e.target.value)}
          data-testid="otp-input"
          disabled={disabled}
        />
        {/* Render children so InputOTPGroup/InputOTPSlot mocks appear in DOM */}
        {children}
      </div>
    );
  },
  InputOTPGroup: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="input-otp-group">{children}</div>
  ),
  InputOTPSlot: ({ index }: { index: number }) => (
    <div data-slot="input-otp-slot" data-index={index} />
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
  capturedOnComplete = undefined;
  capturedDisabled = false;
  capturedValue = '';
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

describe('PasscodeGate', () => {
  it('renders DorkOS logo', () => {
    render(<PasscodeGate onSuccess={vi.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('dork-logo')).toBeDefined();
  });

  it('renders "Enter passcode" heading', () => {
    render(<PasscodeGate onSuccess={vi.fn()} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('heading', { name: /enter passcode/i })).toBeDefined();
  });

  it('renders 6 digit input slots', () => {
    render(<PasscodeGate onSuccess={vi.fn()} />, {
      wrapper: createWrapper(),
    });
    const slots = document.querySelectorAll('[data-slot="input-otp-slot"]');
    expect(slots).toHaveLength(6);
  });

  it('calls verifyTunnelPasscode when all 6 digits are entered via onComplete', async () => {
    const transport = createMockTransport({
      verifyTunnelPasscode: vi.fn().mockResolvedValue({ ok: true }),
    });
    const onSuccess = vi.fn();

    render(<PasscodeGate onSuccess={onSuccess} />, {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      capturedOnComplete?.('123456');
    });

    await waitFor(() => {
      expect(transport.verifyTunnelPasscode).toHaveBeenCalledWith('123456');
    });
  });

  it('shows error message on failed verification', async () => {
    const transport = createMockTransport({
      verifyTunnelPasscode: vi.fn().mockResolvedValue({ ok: false, error: 'Invalid passcode' }),
    });

    render(<PasscodeGate onSuccess={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      capturedOnComplete?.('000000');
    });

    await waitFor(() => {
      expect(screen.getByText('Invalid passcode')).toBeDefined();
    });
  });

  it('clears input value on failed verification', async () => {
    const transport = createMockTransport({
      verifyTunnelPasscode: vi.fn().mockResolvedValue({ ok: false, error: 'Wrong passcode' }),
    });

    render(<PasscodeGate onSuccess={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      capturedOnComplete?.('111111');
    });

    await waitFor(() => {
      expect(screen.getByTestId('otp-input')).toBeDefined();
      expect((screen.getByTestId('otp-input') as HTMLInputElement).value).toBe('');
    });
  });

  it('calls onSuccess on successful verification', async () => {
    const transport = createMockTransport({
      verifyTunnelPasscode: vi.fn().mockResolvedValue({ ok: true }),
    });
    const onSuccess = vi.fn();

    render(<PasscodeGate onSuccess={onSuccess} />, {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      capturedOnComplete?.('654321');
    });

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it('shows error message on network failure', async () => {
    const transport = createMockTransport({
      verifyTunnelPasscode: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    render(<PasscodeGate onSuccess={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      capturedOnComplete?.('999999');
    });

    await waitFor(() => {
      expect(screen.getByText('Connection error. Try again.')).toBeDefined();
    });
  });

  it('disables input while verification is in progress', async () => {
    let resolveVerify: (value: { ok: boolean }) => void;
    const verifyPromise = new Promise<{ ok: boolean }>((resolve) => {
      resolveVerify = resolve;
    });
    const transport = createMockTransport({
      verifyTunnelPasscode: vi.fn().mockReturnValue(verifyPromise),
    });

    render(<PasscodeGate onSuccess={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      capturedOnComplete?.('123456');
    });

    // During async verification the disabled flag should be true
    expect(capturedDisabled).toBe(true);

    await act(async () => {
      resolveVerify!({ ok: true });
    });
  });

  it('shows verifying text while verification is in progress', async () => {
    let resolveVerify: (value: { ok: boolean }) => void;
    const verifyPromise = new Promise<{ ok: boolean }>((resolve) => {
      resolveVerify = resolve;
    });
    const transport = createMockTransport({
      verifyTunnelPasscode: vi.fn().mockReturnValue(verifyPromise),
    });

    render(<PasscodeGate onSuccess={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      capturedOnComplete?.('123456');
    });

    expect(screen.getByText('Verifying...')).toBeDefined();

    await act(async () => {
      resolveVerify!({ ok: true });
    });
  });
});
