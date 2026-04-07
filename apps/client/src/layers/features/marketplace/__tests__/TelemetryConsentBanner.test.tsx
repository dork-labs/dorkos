/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { TelemetryConsentBanner } from '../ui/TelemetryConsentBanner';

// ---------------------------------------------------------------------------
// Mock the config entity. The banner reads from `useConfig` and writes via
// `useUpdateConfig` — both can be controlled per-test through the helpers
// below without needing a TransportProvider or QueryClient.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/config', () => ({
  useConfig: vi.fn(),
  useUpdateConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

interface TelemetryConfigState {
  enabled?: boolean;
  userHasDecided?: boolean;
}

function setConfigState(telemetry: TelemetryConfigState | null) {
  vi.mocked(useConfig).mockReturnValue({
    data:
      telemetry === null
        ? undefined
        : {
            telemetry: {
              enabled: telemetry.enabled ?? false,
              userHasDecided: telemetry.userHasDecided ?? false,
            },
          },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useConfig>);
}

const updateMutate = vi.fn();

function setUpdateConfigState() {
  updateMutate.mockReset();
  vi.mocked(useUpdateConfig).mockReturnValue({
    mutate: updateMutate,
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateConfig>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelemetryConsentBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setUpdateConfigState();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders when the user has not yet decided', () => {
    setConfigState({ enabled: false, userHasDecided: false });

    render(<TelemetryConsentBanner />);

    expect(screen.getByText(/help improve the marketplace/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /no thanks/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send anonymous events/i })).toBeInTheDocument();
  });

  it('renders when the config has not loaded yet (defensive)', () => {
    setConfigState(null);

    render(<TelemetryConsentBanner />);

    // No `userHasDecided` flag means we still want to show the banner so the
    // user is not told their preference is recorded when it isn't.
    expect(screen.getByText(/help improve the marketplace/i)).toBeInTheDocument();
  });

  it('does not render when userHasDecided is true (opted in)', () => {
    setConfigState({ enabled: true, userHasDecided: true });

    const { container } = render(<TelemetryConsentBanner />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/help improve the marketplace/i)).not.toBeInTheDocument();
  });

  it('does not render when userHasDecided is true (opted out)', () => {
    setConfigState({ enabled: false, userHasDecided: true });

    const { container } = render(<TelemetryConsentBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('clicking "No thanks" patches telemetry to disabled + decided', async () => {
    const user = userEvent.setup();
    setConfigState({ enabled: false, userHasDecided: false });

    render(<TelemetryConsentBanner />);

    await user.click(screen.getByRole('button', { name: /no thanks/i }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { enabled: false, userHasDecided: true },
    });
  });

  it('clicking "Send anonymous events" patches telemetry to enabled + decided', async () => {
    const user = userEvent.setup();
    setConfigState({ enabled: false, userHasDecided: false });

    render(<TelemetryConsentBanner />);

    await user.click(screen.getByRole('button', { name: /send anonymous events/i }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { enabled: true, userHasDecided: true },
    });
  });

  it('renders the privacy contract link with safe target/rel attributes', () => {
    setConfigState({ enabled: false, userHasDecided: false });

    render(<TelemetryConsentBanner />);

    const link = screen.getByRole('link', { name: /privacy contract/i });
    expect(link).toHaveAttribute('href', 'https://dorkos.ai/marketplace/privacy');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('disables both buttons while the update is pending', () => {
    setConfigState({ enabled: false, userHasDecided: false });
    vi.mocked(useUpdateConfig).mockReturnValue({
      mutate: updateMutate,
      mutateAsync: vi.fn(),
      isPending: true,
      isSuccess: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useUpdateConfig>);

    render(<TelemetryConsentBanner />);

    expect(screen.getByRole('button', { name: /no thanks/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /send anonymous events/i })).toBeDisabled();
  });
});
