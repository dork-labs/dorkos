/**
 * @vitest-environment jsdom
 *
 * Spec `full-power-defaults` D3, task 3.1 — the new-user double-show guard.
 *
 * A new user meets the power question ONCE, as the onboarding stage. The rail's
 * full-power MOMENT must never fire on top of the onboarding overlay, or a person
 * mid-flow would be asked the same thing twice. This composes the REAL collector
 * (the real full-power descriptor + door) with `MomentHost`, on a config where
 * the door WOULD be eligible, and proves the overlay gate suppresses it — then
 * that it opens once the overlay is gone.
 *
 * The generic overlay-suppression rule is pinned in MomentHost.test with a fake
 * moment; this pins it end to end for the actual door, which is the surface 3.1's
 * invariant is about.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { useSetOpenMesh } from '@/layers/entities/mesh';
import { useAppStore } from '@/layers/shared/model';

import { MomentHost } from '@/layers/widgets/moments';

// Preserve `configKeys` (the door invalidates the config prefix through the real
// query client); mock only the reads/writes so the door is eligible and inert.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useConfig: vi.fn(), useUpdateConfig: vi.fn() };
});
vi.mock('@/layers/entities/mesh', () => ({ useSetOpenMesh: vi.fn() }));

/** A config where the full-power door is eligible: onboarding over, power undecided. */
function setEligibleConfig() {
  vi.mocked(useConfig).mockReturnValue({
    data: {
      onboarding: { completedAt: '2026-08-01T10:00:00.000Z', dismissedAt: null },
      ui: { fullPowerDecidedAt: null },
      telemetry: { userHasDecided: true },
      auth: { enabled: false },
    },
    // The host opens a moment only off a config the server confirmed THIS launch,
    // measured as `dataUpdatedAt` against a `LAUNCH_STARTED_AT` sampled at module
    // load — so a stamp a million ms ahead of now is unambiguously within it.
    // Feeding the retired `isFetchedAfterMount` instead leaves `dataUpdatedAt`
    // undefined, which reads as a stale restored cache and holds every moment
    // down: the suppression case below then passes for the wrong reason.
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
  vi.mocked(useSetOpenMesh).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useSetOpenMesh>);
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

describe('full-power moment — suppressed under the onboarding overlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ momentShownThisLaunch: false });
    setEligibleConfig();
  });

  afterEach(cleanup);

  it('does not fire the full-power door while the onboarding overlay is mounted', () => {
    renderHost(true);

    // The door would be eligible (onboarding over, decision null) — the overlay
    // gate is the only thing keeping it down, so the new user is never asked twice.
    expect(screen.queryByTestId('full-power-door')).not.toBeInTheDocument();
    // Suppression must not spend the launch's one moment.
    expect(useAppStore.getState().momentShownThisLaunch).toBe(false);
  });

  it('opens the same eligible door once the overlay is gone', async () => {
    renderHost(false);

    expect(await screen.findByTestId('full-power-door')).toBeInTheDocument();
  });
});
