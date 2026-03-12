import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePulsePresetDialog } from '../model/use-pulse-preset-dialog';
import type { PulsePreset } from '@dorkos/shared/types';

const MOCK_PRESET: PulsePreset = {
  id: 'health-check',
  name: 'Health Check',
  description: 'Run lint, tests, and type-check to catch issues early.',
  prompt: 'Run the project health checks: lint, test, and typecheck.',
  cron: '0 8 * * 1',
  timezone: 'UTC',
  category: 'maintenance',
};

describe('usePulsePresetDialog', () => {
  beforeEach(() => {
    // Reset Zustand store between tests
    act(() => {
      usePulsePresetDialog.setState({ pendingPreset: null, externalTrigger: false });
    });
  });

  it('initialises with null pendingPreset and externalTrigger=false', () => {
    const { result } = renderHook(() => usePulsePresetDialog());
    expect(result.current.pendingPreset).toBeNull();
    expect(result.current.externalTrigger).toBe(false);
  });

  it('openWithPreset sets pendingPreset and externalTrigger=true', () => {
    const { result } = renderHook(() => usePulsePresetDialog());
    act(() => {
      result.current.openWithPreset(MOCK_PRESET);
    });
    expect(result.current.pendingPreset).toEqual(MOCK_PRESET);
    expect(result.current.externalTrigger).toBe(true);
  });

  it('clear resets pendingPreset to null and externalTrigger to false', () => {
    const { result } = renderHook(() => usePulsePresetDialog());
    act(() => {
      result.current.openWithPreset(MOCK_PRESET);
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.pendingPreset).toBeNull();
    expect(result.current.externalTrigger).toBe(false);
  });

  it('calling openWithPreset twice overwrites the previous preset', () => {
    const OTHER: PulsePreset = { ...MOCK_PRESET, id: 'docs-sync', name: 'Docs Sync' };
    const { result } = renderHook(() => usePulsePresetDialog());
    act(() => {
      result.current.openWithPreset(MOCK_PRESET);
    });
    act(() => {
      result.current.openWithPreset(OTHER);
    });
    expect(result.current.pendingPreset?.id).toBe('docs-sync');
  });
});
