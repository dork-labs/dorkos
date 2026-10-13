/**
 * @vitest-environment jsdom
 *
 * The trust notice never covers the first run (spec `trusted-by-default-flip`
 * §5.8, spec `one-minute-onboarding` §2.4).
 *
 * This composes the REAL collector (the real trust-notice descriptor and body)
 * with `MomentHost`, on a config where the notice WOULD be eligible, and proves
 * the rail keeps it down over the onboarding overlay and in the launch the
 * first run ended in, then opens it once neither holds. A fresh install
 * therefore meets the notice on its next launch, never on top of #team and
 * DorkBot's welcome.
 *
 * The generic overlay-suppression rule is pinned in MomentHost.test with a fake
 * moment; this pins it end to end for the actual notice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { useAppStore } from '@/layers/shared/model';

import { MomentHost } from '@/layers/widgets/moments';

// Mock only the reads and writes, so the notice is eligible and inert.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useConfig: vi.fn(), useUpdateConfig: vi.fn() };
});
vi.mock('@/layers/entities/permissions', () => ({
  useSetPermission: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
}));

/** A config where the notice is eligible: onboarding over, Trusted, not seen. */
function setEligibleConfig() {
  vi.mocked(useConfig).mockReturnValue({
    data: {
      onboarding: { completedAt: '2026-08-01T10:00:00.000Z', dismissedAt: null },
      ui: { trustNoticeSeenAt: null },
      permissions: { preset: 'trusted' },
      telemetry: { userHasDecided: true },
      auth: { enabled: false },
    },
    // The host opens a moment only off a config the server confirmed THIS
    // launch (`dataUpdatedAt` against `LAUNCH_STARTED_AT`), so a stamp well
    // ahead of now is unambiguously within it.
    dataUpdatedAt: Date.now() + 1_000_000,
  } as unknown as ReturnType<typeof useConfig>);
  vi.mocked(useUpdateConfig).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateConfig>);
}

function renderHost(onboardingOverlayVisible: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MomentHost onboardingOverlayVisible={onboardingOverlayVisible} />
    </QueryClientProvider>
  );
}

describe('trust notice — kept off the first run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ momentShownThisLaunch: false, onboardingHiddenForSession: false });
    setEligibleConfig();
  });

  afterEach(cleanup);

  it('does not open while the onboarding overlay is mounted', () => {
    renderHost(true);

    expect(screen.queryByTestId('trust-notice')).not.toBeInTheDocument();
    // Suppression must not spend the launch's one moment.
    expect(useAppStore.getState().momentShownThisLaunch).toBe(false);
  });

  it('waits for the next launch when the first run ended in this one', () => {
    useAppStore.setState({ onboardingHiddenForSession: true });
    renderHost(false);

    expect(screen.queryByTestId('trust-notice')).not.toBeInTheDocument();
    expect(useAppStore.getState().momentShownThisLaunch).toBe(false);
  });

  it('opens on a later launch, once neither holds', async () => {
    renderHost(false);

    expect(await screen.findByTestId('trust-notice')).toBeInTheDocument();
  });
});
