/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useConfig } from '@/layers/entities/config';

import { useMoments, MOMENT_PRIORITY, type MomentDescriptor } from '@/layers/widgets/moments';

import { useTelemetryMomentDescriptor, useFullPowerMomentDescriptor } from '../model/use-moments';

// The full-power descriptor's `render` mounts `FullPowerDoorMoment`, which reaches
// for a router; these tests only exercise ELIGIBILITY (the returned descriptor,
// never its render), so the feature is stubbed to keep the collector renderable
// without a RouterProvider or a Transport.
vi.mock('@/layers/features/full-power-door', () => ({
  FullPowerDoorMoment: () => null,
}));

vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useConfig: vi.fn() };
});

/** Drive the telemetry half of the config. `null` = config has not loaded. */
function setTelemetry(telemetry: { userHasDecided: boolean } | null) {
  vi.mocked(useConfig).mockReturnValue({
    data:
      telemetry === null ? undefined : { telemetry: { userHasDecided: telemetry.userHasDecided } },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useConfig>);
}

describe('useMoments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the telemetry moment while the user has not decided', () => {
    setTelemetry({ userHasDecided: false });

    const { result } = renderHook(() => useMoments());

    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe('telemetry-consent');
    expect(result.current[0].priority).toBe(MOMENT_PRIORITY.low);
  });

  it('offers the telemetry moment while config is still loading in', () => {
    setTelemetry(null);

    const { result } = renderHook(() => useMoments());

    expect(result.current.map((m) => m.id)).toEqual(['telemetry-consent']);
  });

  it('drops the telemetry moment once the user has decided', () => {
    setTelemetry({ userHasDecided: true });

    const { result } = renderHook(() => useMoments());

    // Filtered out entirely — an ineligible moment is absent from the array,
    // not a null sitting in it where it could occupy the winning slot.
    expect(result.current).toEqual([]);
  });

  it('takes a second moment as one descriptor hook plus one line', () => {
    // The telemetry moment is ineligible here, so this also pins the property
    // the whole descriptor-hook convention exists for: a moment that returns
    // null cannot suppress an eligible peer.
    setTelemetry({ userHasDecided: true });

    /** Stands in for the full-power door — the rail's next consumer. */
    function useDoorDescriptor(): MomentDescriptor | null {
      return { id: 'full-power-door', priority: MOMENT_PRIORITY.high, render: () => null };
    }

    /** `useMoments` with exactly one line appended. */
    function useExtendedMoments(): MomentDescriptor[] {
      const telemetry = useTelemetryMomentDescriptor();
      const door = useDoorDescriptor();
      return [telemetry, door].filter((d): d is MomentDescriptor => d !== null);
    }

    const { result } = renderHook(() => useExtendedMoments());

    expect(result.current.map((m) => m.id)).toEqual(['full-power-door']);
  });
});

/**
 * Drive the config the full-power descriptor reads. `null` = config has not
 * loaded; otherwise onboarding defaults to finished and telemetry to decided, so
 * a test names only the field it is about.
 */
function setConfig(
  cfg: {
    onboarding?: { completedAt?: string | null; dismissedAt?: string | null } | null;
    fullPowerDecidedAt?: string | null;
    telemetryDecided?: boolean;
  } | null
) {
  vi.mocked(useConfig).mockReturnValue({
    data:
      cfg === null
        ? undefined
        : {
            onboarding:
              cfg.onboarding === undefined
                ? { completedAt: '2026-08-01T10:00:00.000Z', dismissedAt: null }
                : cfg.onboarding,
            ui: { fullPowerDecidedAt: cfg.fullPowerDecidedAt ?? null },
            telemetry: { userHasDecided: cfg.telemetryDecided ?? true },
          },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useConfig>);
}

describe('useFullPowerMomentDescriptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the door when onboarding is over and the power question is unanswered', () => {
    setConfig({ fullPowerDecidedAt: null });

    const { result } = renderHook(() => useFullPowerMomentDescriptor());

    expect(result.current?.id).toBe('full-power-door');
    expect(result.current?.priority).toBe(MOMENT_PRIORITY.high);
  });

  it('outranks the telemetry invitation — high beats low', () => {
    expect(MOMENT_PRIORITY.high).toBeGreaterThan(MOMENT_PRIORITY.low);
  });

  it('is eligible when onboarding was deliberately dismissed rather than completed', () => {
    setConfig({ onboarding: { completedAt: null, dismissedAt: '2026-08-01T10:00:00.000Z' } });

    const { result } = renderHook(() => useFullPowerMomentDescriptor());

    expect(result.current?.id).toBe('full-power-door');
  });

  it('never offers the door once the power question has been answered', () => {
    setConfig({ fullPowerDecidedAt: '2026-08-02T09:00:00.000Z' });

    const { result } = renderHook(() => useFullPowerMomentDescriptor());

    expect(result.current).toBeNull();
  });

  it('withholds the door while onboarding is neither finished nor dismissed', () => {
    setConfig({ onboarding: { completedAt: null, dismissedAt: null }, fullPowerDecidedAt: null });

    const { result } = renderHook(() => useFullPowerMomentDescriptor());

    expect(result.current).toBeNull();
  });

  it('withholds the door until config has loaded', () => {
    setConfig(null);

    const { result } = renderHook(() => useFullPowerMomentDescriptor());

    expect(result.current).toBeNull();
  });

  it('is collected above telemetry when both are eligible', () => {
    // Onboarding over, power unanswered, telemetry undecided → both eligible.
    setConfig({ fullPowerDecidedAt: null, telemetryDecided: false });

    const { result } = renderHook(() => useMoments());

    const ids = result.current.map((m) => m.id);
    expect(ids).toContain('full-power-door');
    expect(ids).toContain('telemetry-consent');
    // Higher priority wins the one slot the host opens.
    const door = result.current.find((m) => m.id === 'full-power-door');
    const telemetry = result.current.find((m) => m.id === 'telemetry-consent');
    expect(door!.priority).toBeGreaterThan(telemetry!.priority);
  });
});
