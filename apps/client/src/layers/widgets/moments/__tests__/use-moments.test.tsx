/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useConfig } from '@/layers/entities/config';

import { useMoments, MOMENT_PRIORITY, type MomentDescriptor } from '@/layers/widgets/moments';

import { useTelemetryMomentDescriptor, useTrustNoticeMomentDescriptor } from '../model/use-moments';

// These tests only exercise ELIGIBILITY (the returned descriptor, never its
// render), so the notice body is stubbed to keep the collector renderable
// without a Transport. The eligibility rule itself stays real.
vi.mock('@/layers/features/trust-notice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/features/trust-notice')>()),
  TrustNoticeMoment: () => null,
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

    /** Stands in for any high-priority moment — the rail's next consumer. */
    function useDoorDescriptor(): MomentDescriptor | null {
      return { id: 'next-moment', priority: MOMENT_PRIORITY.high, render: () => null };
    }

    /** `useMoments` with exactly one line appended. */
    function useExtendedMoments(): MomentDescriptor[] {
      const telemetry = useTelemetryMomentDescriptor();
      const door = useDoorDescriptor();
      return [telemetry, door].filter((d): d is MomentDescriptor => d !== null);
    }

    const { result } = renderHook(() => useExtendedMoments());

    expect(result.current.map((m) => m.id)).toEqual(['next-moment']);
  });
});

/**
 * Drive the config the trust-notice descriptor reads. `null` = config has not
 * loaded; otherwise onboarding defaults to finished, the preset to Trusted and
 * telemetry to decided, so a test names only the field it is about.
 */
function setConfig(
  cfg: {
    onboarding?: { completedAt?: string | null; dismissedAt?: string | null } | null;
    trustNoticeSeenAt?: string | null;
    preset?: string | null;
    telemetryDecided?: boolean;
    callerRoute?: 'local' | 'wifi';
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
            ui: { trustNoticeSeenAt: cfg.trustNoticeSeenAt ?? null },
            permissions: { preset: cfg.preset === undefined ? 'trusted' : cfg.preset },
            telemetry: { userHasDecided: cfg.telemetryDecided ?? true },
            callerRoute: cfg.callerRoute,
          },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useConfig>);
}

describe('useTrustNoticeMomentDescriptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the notice when onboarding is over, the install is Trusted and it is unseen', () => {
    setConfig({ trustNoticeSeenAt: null });

    const { result } = renderHook(() => useTrustNoticeMomentDescriptor());

    expect(result.current?.id).toBe('trust-notice');
    expect(result.current?.priority).toBe(MOMENT_PRIORITY.high);
  });

  it('offers it to an install that never chose a preset, which runs Trusted', () => {
    setConfig({ preset: null });

    const { result } = renderHook(() => useTrustNoticeMomentDescriptor());

    expect(result.current?.id).toBe('trust-notice');
  });

  it('is eligible when onboarding was dismissed rather than completed', () => {
    setConfig({ onboarding: { completedAt: null, dismissedAt: '2026-08-01T10:00:00.000Z' } });

    const { result } = renderHook(() => useTrustNoticeMomentDescriptor());

    expect(result.current?.id).toBe('trust-notice');
  });

  it('never offers it once seen', () => {
    setConfig({ trustNoticeSeenAt: '2026-08-02T09:00:00.000Z' });

    const { result } = renderHook(() => useTrustNoticeMomentDescriptor());

    expect(result.current).toBeNull();
  });

  it('holds it on Wi-Fi, where agents still ask, and offers it from this computer', () => {
    setConfig({ callerRoute: 'wifi' });
    const { result, rerender } = renderHook(() => useTrustNoticeMomentDescriptor());
    // Never offered on Wi-Fi, so nothing there can mark it seen.
    expect(result.current).toBeNull();

    setConfig({ callerRoute: 'local' });
    rerender();
    expect(result.current?.id).toBe('trust-notice');
  });

  it('never offers it to a Careful install', () => {
    setConfig({ preset: 'careful' });

    const { result } = renderHook(() => useTrustNoticeMomentDescriptor());

    expect(result.current).toBeNull();
  });

  it('withholds it while onboarding is neither finished nor dismissed', () => {
    setConfig({ onboarding: { completedAt: null, dismissedAt: null } });

    const { result } = renderHook(() => useTrustNoticeMomentDescriptor());

    expect(result.current).toBeNull();
  });

  it('withholds it until config has loaded', () => {
    setConfig(null);

    const { result } = renderHook(() => useTrustNoticeMomentDescriptor());

    expect(result.current).toBeNull();
  });

  it('is collected above telemetry when both are eligible', () => {
    setConfig({ telemetryDecided: false });

    const { result } = renderHook(() => useMoments());

    const notice = result.current.find((m) => m.id === 'trust-notice');
    const telemetry = result.current.find((m) => m.id === 'telemetry-consent');
    expect(notice).toBeDefined();
    expect(telemetry).toBeDefined();
    // Higher priority wins the one slot the host opens.
    expect(notice!.priority).toBeGreaterThan(telemetry!.priority);
  });
});
