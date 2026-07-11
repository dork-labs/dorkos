/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { TelemetryConsentBanner } from '../ui/TelemetryConsentBanner';

// The banner reads from `useConfig` and writes via `useUpdateConfig`; both are
// mocked so no TransportProvider or QueryClient is needed.
vi.mock('@/layers/entities/config', () => ({
  useConfig: vi.fn(),
  useUpdateConfig: vi.fn(),
}));

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

  it('renders and shows the heartbeat payload verbatim when undecided', () => {
    setConfigState({ userHasDecided: false });

    render(<TelemetryConsentBanner />);

    expect(screen.getByText(/share anonymous usage data/i)).toBeInTheDocument();
    expect(screen.getByText(/runtimesConfigured/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /no thanks/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /share anonymous data/i })).toBeInTheDocument();
  });

  it('renders defensively when config has not loaded yet', () => {
    setConfigState(null);
    render(<TelemetryConsentBanner />);
    expect(screen.getByText(/share anonymous usage data/i)).toBeInTheDocument();
  });

  it('does not render once the user has decided', () => {
    setConfigState({ userHasDecided: true });
    const { container } = render(<TelemetryConsentBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opting in turns on both channels and records the decision', async () => {
    const user = userEvent.setup();
    setConfigState({ userHasDecided: false });

    render(<TelemetryConsentBanner />);
    await user.click(screen.getByRole('button', { name: /share anonymous data/i }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { install: true, heartbeat: true, userHasDecided: true },
    });
  });

  it('opting out leaves both channels off and records the decision', async () => {
    const user = userEvent.setup();
    setConfigState({ userHasDecided: false });

    render(<TelemetryConsentBanner />);
    await user.click(screen.getByRole('button', { name: /no thanks/i }));

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

    expect(screen.getByRole('button', { name: /no thanks/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /share anonymous data/i })).toBeDisabled();
  });
});
