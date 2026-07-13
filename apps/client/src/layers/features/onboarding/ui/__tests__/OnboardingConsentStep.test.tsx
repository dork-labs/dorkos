/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useUpdateConfig } from '@/layers/entities/config';
import { OnboardingConsentStep } from '../OnboardingConsentStep';

vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useUpdateConfig: vi.fn() };
});

// Mutate mock invokes the caller's onSettled so `onComplete` fires like the real
// mutation would once the write settles.
const updateMutate = vi.fn((_patch: unknown, opts?: { onSettled?: () => void }) =>
  opts?.onSettled?.()
);

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

describe('OnboardingConsentStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMutate.mockClear();
    setUpdate();
  });

  afterEach(() => cleanup());

  it('shows the disclosure, the payload, and the contract link', () => {
    render(<OnboardingConsentStep onComplete={vi.fn()} />);
    expect(screen.getByText(/shares a little anonymous data/i)).toBeInTheDocument();
    expect(screen.getByText(/runtimesConfigured/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /full contract/i })).toHaveAttribute(
      'href',
      'https://dorkos.ai/telemetry'
    );
  });

  it('keeping sharing leaves both channels on, records the decision, and advances', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<OnboardingConsentStep onComplete={onComplete} />);

    await user.click(screen.getByRole('button', { name: /keep sharing/i }));

    expect(updateMutate).toHaveBeenCalledWith(
      { telemetry: { install: true, heartbeat: true, userHasDecided: true } },
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('turning off zeroes both channels, records the decision, and advances', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<OnboardingConsentStep onComplete={onComplete} />);

    await user.click(screen.getByRole('button', { name: /turn off/i }));

    expect(updateMutate).toHaveBeenCalledWith(
      { telemetry: { install: false, heartbeat: false, userHasDecided: true } },
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while the write is pending', () => {
    setUpdate(true);
    render(<OnboardingConsentStep onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: /turn off/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /keep sharing/i })).toBeDisabled();
  });
});
