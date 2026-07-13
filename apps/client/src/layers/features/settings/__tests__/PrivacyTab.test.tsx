/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { PrivacyTab } from '../ui/PrivacyTab';

// PrivacyTab reads via `useConfig` and writes via `useUpdateConfig`; both are
// mocked so no TransportProvider or QueryClient is needed (see testing.md).
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return {
    ...actual,
    useConfig: vi.fn(),
    useUpdateConfig: vi.fn(),
  };
});

interface TelemetryState {
  install?: boolean;
  heartbeat?: boolean;
  errorReporting?: boolean;
  usage?: boolean;
  userHasDecided?: boolean;
}

function setConfig(telemetry: TelemetryState | null) {
  vi.mocked(useConfig).mockReturnValue({
    data:
      telemetry === null
        ? undefined
        : {
            telemetry: {
              install: telemetry.install ?? false,
              heartbeat: telemetry.heartbeat ?? false,
              errorReporting: telemetry.errorReporting ?? false,
              usage: telemetry.usage ?? false,
              userHasDecided: telemetry.userHasDecided ?? false,
            },
          },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useConfig>);
}

const updateMutate = vi.fn();

function setUpdate(isPending = false) {
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

describe('PrivacyTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMutate.mockReset();
    setUpdate();
  });

  afterEach(() => cleanup());

  it('renders the four channel toggles, the payload, and the contract link', () => {
    setConfig({});
    render(<PrivacyTab />);

    expect(
      screen.getByRole('switch', { name: /share anonymous install counts/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: /share an anonymous daily heartbeat/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: /share anonymous feature-usage events/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /share crash reports/i })).toBeInTheDocument();

    expect(screen.getByText(/runtimesConfigured/)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /full contract/i });
    expect(link).toHaveAttribute('href', 'https://dorkos.ai/telemetry');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('reflects the current channel states', () => {
    setConfig({
      install: true,
      heartbeat: false,
      errorReporting: true,
      usage: true,
      userHasDecided: true,
    });
    render(<PrivacyTab />);

    expect(screen.getByRole('switch', { name: /install counts/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /daily heartbeat/i })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /feature-usage events/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /crash reports/i })).toBeChecked();
  });

  it('toggling heartbeat on patches the channel and records the decision', async () => {
    const user = userEvent.setup();
    setConfig({ heartbeat: false });
    render(<PrivacyTab />);

    await user.click(screen.getByRole('switch', { name: /daily heartbeat/i }));

    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { heartbeat: true, userHasDecided: true },
    });
  });

  it('toggling install off patches only that channel plus the decision gate', async () => {
    const user = userEvent.setup();
    setConfig({ install: true });
    render(<PrivacyTab />);

    await user.click(screen.getByRole('switch', { name: /install counts/i }));

    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { install: false, userHasDecided: true },
    });
  });

  it('toggling usage off patches only that channel plus the decision gate', async () => {
    const user = userEvent.setup();
    setConfig({ usage: true });
    render(<PrivacyTab />);

    await user.click(screen.getByRole('switch', { name: /feature-usage events/i }));

    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { usage: false, userHasDecided: true },
    });
  });

  it('disables the switches while a write is pending', () => {
    setConfig({});
    setUpdate(true);
    render(<PrivacyTab />);

    expect(screen.getByRole('switch', { name: /install counts/i })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /crash reports/i })).toBeDisabled();
  });
});
