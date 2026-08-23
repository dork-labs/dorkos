/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useConfig } from '@/layers/entities/config';

import { useMoments, MOMENT_PRIORITY, type MomentDescriptor } from '@/layers/widgets/moments';

import { useTelemetryMomentDescriptor } from '../model/use-moments';

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
