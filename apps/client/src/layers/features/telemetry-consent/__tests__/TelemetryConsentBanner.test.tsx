/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { TelemetryConsentBanner } from '../ui/TelemetryConsentBanner';

// motion (used by the Banner details region) reads matchMedia for reduced-motion,
// which jsdom does not implement.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// The banner reads from `useConfig` and writes via `useUpdateConfig`; both are
// mocked so no TransportProvider or QueryClient is needed. Other exports
// (the TelemetryPayload* components) are preserved via importOriginal.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useConfig: vi.fn(), useUpdateConfig: vi.fn() };
});

interface TelemetryConfigState {
  userHasDecided?: boolean;
  install?: boolean;
  heartbeat?: boolean;
}

function setConfigState(telemetry: TelemetryConfigState | null) {
  vi.mocked(useConfig).mockReturnValue({
    data:
      telemetry === null
        ? undefined
        : {
            telemetry: {
              userHasDecided: telemetry.userHasDecided ?? false,
              install: telemetry.install ?? false,
              heartbeat: telemetry.heartbeat ?? false,
              errorReporting: false,
            },
          },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useConfig>);
}

const updateMutate = vi.fn();

function setUpdateConfigState(isPending = false) {
  vi.mocked(useUpdateConfig).mockReturnValue({
    mutate: updateMutate,
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateConfig>);
}

describe('TelemetryConsentBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMutate.mockReset();
    setUpdateConfigState();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the disclosure and consent buttons, with the payload collapsed by default', () => {
    setConfigState({ userHasDecided: false });

    render(<TelemetryConsentBanner />);

    expect(screen.getByText(/shares a little anonymous data/i)).toBeInTheDocument();
    // Progressive disclosure: the payload stays hidden until asked for.
    expect(screen.queryByText(/runtimesConfigured/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /see what.s sent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /turn off/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep sharing/i })).toBeInTheDocument();
  });

  it('reveals the heartbeat payload verbatim after clicking "See what\'s sent"', async () => {
    const user = userEvent.setup();
    setConfigState({ userHasDecided: false });

    render(<TelemetryConsentBanner />);
    await user.click(screen.getByRole('button', { name: /see what.s sent/i }));

    expect(await screen.findByText(/runtimesConfigured/)).toBeInTheDocument();
  });

  it('renders defensively when config has not loaded yet', () => {
    setConfigState(null);
    render(<TelemetryConsentBanner />);
    expect(screen.getByText(/shares a little anonymous data/i)).toBeInTheDocument();
  });

  it('does not render once the user has decided', () => {
    setConfigState({ userHasDecided: true });
    const { container } = render(<TelemetryConsentBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeping sharing leaves both channels on and records the decision', async () => {
    const user = userEvent.setup();
    setConfigState({ userHasDecided: false });

    render(<TelemetryConsentBanner />);
    await user.click(screen.getByRole('button', { name: /keep sharing/i }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { install: true, heartbeat: true, userHasDecided: true },
    });
  });

  it('turning off zeroes both channels and records the decision', async () => {
    const user = userEvent.setup();
    setConfigState({ userHasDecided: false });

    render(<TelemetryConsentBanner />);
    await user.click(screen.getByRole('button', { name: /turn off/i }));

    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { install: false, heartbeat: false, userHasDecided: true },
    });
  });

  it('links to the public telemetry contract with safe attributes', () => {
    setConfigState({ userHasDecided: false });
    render(<TelemetryConsentBanner />);

    const link = screen.getByRole('link', { name: /full contract/i });
    expect(link).toHaveAttribute('href', 'https://dorkos.ai/telemetry');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('disables both buttons while the update is pending', () => {
    setConfigState({ userHasDecided: false });
    setUpdateConfigState(true);

    render(<TelemetryConsentBanner />);

    expect(screen.getByRole('button', { name: /turn off/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /keep sharing/i })).toBeDisabled();
  });
});
